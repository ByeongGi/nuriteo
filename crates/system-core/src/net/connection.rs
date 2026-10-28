use super::buffer::NetBuffer;

/// Identifier of a listening port.
#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ListenerId(pub u32);

/// Identifier of one in-memory connection.
#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ConnectionId(pub u32);

/// Client or server side of a connection.
#[derive(Debug, Copy, Clone, PartialEq, Eq, Hash)]
pub enum ConnectionEndpoint {
    /// Side that connected to a listening port.
    Client,
    /// Side returned by accept.
    Server,
}

/// Paired buffers for one accepted connection.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Connection {
    /// Identifier returned to both sides.
    pub id: ConnectionId,
    /// Listener that accepted this connection.
    pub listener: ListenerId,
    /// Bytes written by the client and read by the server.
    pub client_to_server: NetBuffer,
    /// Bytes written by the server and read by the client.
    pub server_to_client: NetBuffer,
    /// The client has not closed its side.
    pub client_open: bool,
    /// The server has not closed its side.
    pub server_open: bool,
}

impl Connection {
    /// Creates a connection with bounded buffers in both directions.
    #[must_use]
    pub fn new(id: ConnectionId, listener: ListenerId, capacity: usize) -> Self {
        Self {
            id,
            listener,
            client_to_server: NetBuffer::bounded(capacity),
            server_to_client: NetBuffer::bounded(capacity),
            client_open: true,
            server_open: true,
        }
    }
}
