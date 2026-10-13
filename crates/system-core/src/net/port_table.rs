use std::collections::{BTreeMap, VecDeque};

use super::{
    buffer::NetBufferError,
    connection::{Connection, ConnectionEndpoint, ConnectionId, ListenerId},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortTableError {
    PortInUse,
    PortNotFound,
    ListenerNotFound,
    ConnectionNotFound,
    ConnectionClosed,
    NoPendingConnection,
    WouldBlock,
}

pub type PortTableResult<T> = Result<T, PortTableError>;

#[derive(Debug, Clone)]
struct Listener {
    port: u16,
    pending: VecDeque<ConnectionId>,
}

#[derive(Debug, Clone)]
pub struct PortTable {
    next_listener: u32,
    next_connection: u32,
    capacity: usize,
    by_port: BTreeMap<u16, ListenerId>,
    listeners: BTreeMap<ListenerId, Listener>,
    connections: BTreeMap<ConnectionId, Connection>,
}

impl PortTable {
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

    pub fn close_listener(&mut self, id: ListenerId) -> PortTableResult<()> {
        let listener = self
            .listeners
            .remove(&id)
            .ok_or(PortTableError::ListenerNotFound)?;
        self.by_port.remove(&listener.port);
        Ok(())
    }

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

    pub fn accept(&mut self, listener: ListenerId) -> PortTableResult<ConnectionId> {
        self.listeners
            .get_mut(&listener)
            .ok_or(PortTableError::ListenerNotFound)?
            .pending
            .pop_front()
            .ok_or(PortTableError::NoPendingConnection)
    }

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
