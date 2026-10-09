use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::thread;
use std::time::Duration;

#[test]
fn stopped_preflight_does_not_interrupt_the_previous_service() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("health probe listener should bind");
    let address = listener
        .local_addr()
        .expect("listener address should exist");
    let service = thread::spawn(move || {
        for connection in listener.incoming().take(2) {
            let mut connection = connection.expect("health probe connection should open");
            let mut request = [0_u8; 256];
            let _ = connection
                .read(&mut request)
                .expect("health probe request should be readable");
            connection
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nready",
                )
                .expect("health probe response should be writable");
        }
    });

    assert_service_ready(address);
    let output = Command::new(env!("CARGO_BIN_EXE_nuriteo-server"))
        .arg("upgrade-preflight")
        .env_clear()
        .output()
        .expect("upgrade-preflight subprocess should start");
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(
        output.stderr,
        b"nuriteo-server: upgrade-preflight stopped (configuration)\n"
    );
    assert_service_ready(address);
    service.join().expect("health probe service should finish");
}

fn assert_service_ready(address: std::net::SocketAddr) {
    let mut connection = TcpStream::connect_timeout(&address, Duration::from_secs(1))
        .expect("previous service should remain reachable");
    connection
        .set_read_timeout(Some(Duration::from_secs(1)))
        .expect("read timeout should be set");
    connection
        .write_all(b"GET /health/ready HTTP/1.1\r\nHost: previous\r\nConnection: close\r\n\r\n")
        .expect("health request should be writable");
    let mut response = Vec::new();
    connection
        .read_to_end(&mut response)
        .expect("health response should be readable");
    assert!(response.starts_with(b"HTTP/1.1 200 OK"));
    assert!(response.ends_with(b"ready"));
}
