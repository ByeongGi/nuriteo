use std::env;
use std::io::{self, Write};
use std::process::ExitCode;

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let stdout = io::stdout();
    let stderr = io::stderr();
    let mut stdout = stdout.lock();
    let mut stderr = stderr.lock();

    match nuriteo_server::run_async(env::args_os().skip(1), &mut stdout, &mut stderr).await {
        Ok(status) => ExitCode::from(status.exit_code()),
        Err(error) => {
            let _ = writeln!(stderr, "nuriteo-server: output error: {error}");
            ExitCode::FAILURE
        }
    }
}
