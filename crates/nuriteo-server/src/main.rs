use std::env;
use std::io::{self, Write};
use std::process::ExitCode;

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    // Do not retain the process-wide stream locks across the long-running
    // server future. The tracing subscriber writes independently and must be
    // able to acquire stderr during startup and graceful shutdown.
    let mut stdout = io::stdout();
    let mut stderr = io::stderr();

    match nuriteo_server::run_async(env::args_os().skip(1), &mut stdout, &mut stderr).await {
        Ok(status) => ExitCode::from(status.exit_code()),
        Err(error) => {
            let _ = writeln!(stderr, "nuriteo-server: output error: {error}");
            ExitCode::FAILURE
        }
    }
}
