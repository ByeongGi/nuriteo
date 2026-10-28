use std::{
    collections::{BTreeMap, VecDeque},
    error::Error,
    fmt::{self, Display, Formatter},
};

use super::{
    buffer::NetBufferError,
    connection::{Connection, ConnectionEndpoint, ConnectionId, ListenerId},
};

/// Why a port-table operation failed.
#[must_use]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PortTableError {
    /// A listener is already bound to the port.
    PortInUse,
    /// No listener is bound to the port.
    PortNotFound,
    /// The listener id is not in the table.
    ListenerNotFound,
    /// The connection id is not in the table.
    ConnectionNotFound,
    /// The endpoint is already closed.
    ConnectionClosed,
    /// Accept found an empty backlog.
    NoPendingConnection,
    /// The bounded buffer cannot take more bytes now.
    WouldBlock,
}

impl Display for PortTableError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::PortInUse => "port is already in use",
            Self::PortNotFound => "port was not found",
            Self::ListenerNotFound => "listener was not found",
            Self::ConnectionNotFound => "connection was not found",
            Self::ConnectionClosed => "connection is closed",
            Self::NoPendingConnection => "no connection is pending",
            Self::WouldBlock => "port operation would block",
        })
    }
}

impl Error for PortTableError {}

/// Port-table operation result alias.
pub type PortTableResult<T> = Result<T, PortTableError>;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Listener {
    port: u16,
    pending: VecDeque<ConnectionId>,
}

/// In-memory map from ports to listeners and connections.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PortTable {
    next_listener: u32,
    next_connection: u32,
    capacity: usize,
    by_port: BTreeMap<u16, ListenerId>,
    listeners: BTreeMap<ListenerId, Listener>,
    connections: BTreeMap<ConnectionId, Connection>,
}

impl PortTable {
    /// Creates an empty port table with the given connection capacity.
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        Self {
            next_listener: 1,
            next_connection: 1,
            capacity,
            by_port: BTreeMap::new(),
            listeners: BTreeMap::new(),
            connections: BTreeMap::new(),
        }
    }

    /// Binds a listener to `port`.
    ///
    /// # Errors
    /// Returns [`PortTableError::PortInUse`] when `port` already has a listener.
    pub fn listen(&mut self, port: u16) -> PortTableResult<ListenerId> {
        if self.by_port.contains_key(&port) {
            return Err(PortTableError::PortInUse);
        }
        let id = ListenerId(self.next_listener);
        self.next_listener += 1;
        self.by_port.insert(port, id);
        self.listeners.insert(
            id,
            Listener {
                port,
                pending: VecDeque::new(),
            },
        );
        Ok(id)
    }

    /// Closes a listener and its pending accepts.
    ///
    /// # Errors
    /// Returns [`PortTableError::ListenerNotFound`] when `id` is not bound.
    pub fn close_listener(&mut self, id: ListenerId) -> PortTableResult<()> {
        let listener = self
            .listeners
            .remove(&id)
            .ok_or(PortTableError::ListenerNotFound)?;
        self.by_port.remove(&listener.port);
        Ok(())
    }

    /// Opens a client connection to a listening port.
    ///
    /// # Errors
    /// Returns [`PortTableError::PortNotFound`] when nothing listens on `port`.
    pub fn connect(&mut self, port: u16) -> PortTableResult<ConnectionId> {
        let listener_id = *self
            .by_port
            .get(&port)
            .ok_or(PortTableError::PortNotFound)?;
        let id = ConnectionId(self.next_connection);
        self.next_connection += 1;
        let connection = Connection::new(id, listener_id, self.capacity);
        self.connections.insert(id, connection);
        self.listeners
            .get_mut(&listener_id)
            .ok_or(PortTableError::ListenerNotFound)?
            .pending
            .push_back(id);
        Ok(id)
    }

    /// Accepts one pending connection on a listener.
    ///
    /// # Errors
    /// Returns [`PortTableError::ListenerNotFound`] when `listener` is absent and
    /// [`PortTableError::NoPendingConnection`] when its backlog is empty.
    pub fn accept(&mut self, listener: ListenerId) -> PortTableResult<ConnectionId> {
        self.listeners
            .get_mut(&listener)
            .ok_or(PortTableError::ListenerNotFound)?
            .pending
            .pop_front()
            .ok_or(PortTableError::NoPendingConnection)
    }

    /// Writes bytes into one side of a connection.
    ///
    /// # Errors
    /// Returns [`PortTableError::ConnectionNotFound`] when `id` is absent,
    /// [`PortTableError::ConnectionClosed`] when the peer has closed, and
    /// [`PortTableError::WouldBlock`] when that direction's buffer is full.
    pub fn write(
        &mut self,
        id: ConnectionId,
        endpoint: ConnectionEndpoint,
        bytes: &[u8],
    ) -> PortTableResult<usize> {
        let connection = self
            .connections
            .get_mut(&id)
            .ok_or(PortTableError::ConnectionNotFound)?;
        match endpoint {
            ConnectionEndpoint::Client => {
                if !connection.server_open {
                    return Err(PortTableError::ConnectionClosed);
                }
                connection
                    .client_to_server
                    .write(bytes)
                    .map_err(map_buffer_error)
            }
            ConnectionEndpoint::Server => {
                if !connection.client_open {
                    return Err(PortTableError::ConnectionClosed);
                }
                connection
                    .server_to_client
                    .write(bytes)
                    .map_err(map_buffer_error)
            }
        }
    }

    /// Reads bytes from one side of a connection.
    ///
    /// # Errors
    /// Returns [`PortTableError::ConnectionNotFound`] when `id` is absent.
    /// An empty buffer returns an empty vector.
    pub fn read(
        &mut self,
        id: ConnectionId,
        endpoint: ConnectionEndpoint,
        len: usize,
    ) -> PortTableResult<Vec<u8>> {
        let connection = self
            .connections
            .get_mut(&id)
            .ok_or(PortTableError::ConnectionNotFound)?;
        Ok(match endpoint {
            ConnectionEndpoint::Client => connection.server_to_client.read(len),
            ConnectionEndpoint::Server => connection.client_to_server.read(len),
        })
    }

    /// Closes one side of a connection.
    ///
    /// # Errors
    /// Returns [`PortTableError::ConnectionNotFound`] when `id` is absent.
    pub fn close(&mut self, id: ConnectionId, endpoint: ConnectionEndpoint) -> PortTableResult<()> {
        let connection = self
            .connections
            .get_mut(&id)
            .ok_or(PortTableError::ConnectionNotFound)?;
        match endpoint {
            ConnectionEndpoint::Client => connection.client_open = false,
            ConnectionEndpoint::Server => connection.server_open = false,
        }
        Ok(())
    }
}

fn map_buffer_error(error: NetBufferError) -> PortTableError {
    match error {
        NetBufferError::WouldBlock => PortTableError::WouldBlock,
    }
}
