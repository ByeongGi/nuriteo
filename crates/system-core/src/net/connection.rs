use super::buffer::NetBuffer;

#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ListenerId(pub u32);

#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ConnectionId(pub u32);

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum ConnectionEndpoint {
    Client,
    Server,
}

#[derive(Debug, Clone)]
pub struct Connection {
    pub id: ConnectionId,
    pub listener: ListenerId,
    pub client_to_server: NetBuffer,
    pub server_to_client: NetBuffer,
    pub client_open: bool,
    pub server_open: bool,
}

impl Connection {
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
