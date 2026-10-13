pub mod buffer;
pub mod connection;
pub mod port_table;

pub use buffer::{NetBuffer, NetBufferError};
pub use connection::{Connection, ConnectionEndpoint, ConnectionId, ListenerId};
pub use port_table::{PortTable, PortTableError, PortTableResult};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_http_request_response_roundtrip() {
        let mut table = PortTable::new(64);
        let listener = table.listen(3000).unwrap();
        let client = table.connect(3000).unwrap();
        let server = table.accept(listener).unwrap();

        table
            .write(
                client,
                ConnectionEndpoint::Client,
                b"GET / HTTP/1.1\r\n\r\n",
            )
            .unwrap();
        assert_eq!(
            table
                .read(server, ConnectionEndpoint::Server, 1024)
                .unwrap(),
            b"GET / HTTP/1.1\r\n\r\n"
        );
        table
            .write(
                server,
                ConnectionEndpoint::Server,
                b"HTTP/1.1 200 OK\r\n\r\nhello",
            )
            .unwrap();
        assert_eq!(
            table
                .read(client, ConnectionEndpoint::Client, 1024)
                .unwrap(),
            b"HTTP/1.1 200 OK\r\n\r\nhello"
        );
    }

    #[test]
    fn reports_port_collision_backpressure_abort_eof_and_relisten() {
        let mut table = PortTable::new(4);
        let listener = table.listen(5173).unwrap();
        assert_eq!(table.listen(5173).unwrap_err(), PortTableError::PortInUse);
        let client = table.connect(5173).unwrap();
        let server = table.accept(listener).unwrap();

        assert_eq!(
            table
                .write(server, ConnectionEndpoint::Server, b"abcdef")
                .unwrap(),
            4
        );
        assert_eq!(
            table
                .write(server, ConnectionEndpoint::Server, b"x")
                .unwrap_err(),
            PortTableError::WouldBlock
        );
        assert_eq!(
            table.read(client, ConnectionEndpoint::Client, 3).unwrap(),
            b"abc"
        );

        table.close(client, ConnectionEndpoint::Client).unwrap();
        assert_eq!(
            table.read(server, ConnectionEndpoint::Server, 8).unwrap(),
            b""
        );
        assert_eq!(
            table
                .write(server, ConnectionEndpoint::Server, b"x")
                .unwrap_err(),
            PortTableError::ConnectionClosed
        );

        table.close_listener(listener).unwrap();
        let relistened = table.listen(5173).unwrap();
        assert_ne!(listener, relistened);
    }
}
