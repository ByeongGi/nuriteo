pub mod kernel;
pub mod pipe;
pub mod pty;
pub mod stdio;
pub mod termios;

pub use kernel::{
    IoError, IoRead, IoResult, IoctlRequest, IoctlResponse, KernelIo, PollState, PtyId, PtyPair,
    TerminalControl,
};
pub use pipe::{Pipe, PipeError, PipeResult};
pub use pty::{
    PtyError, PtyEvent, PtyLimits, PtyRead, PtyReady, PtyResult, TerminalSize, VirtualPty,
};
pub use stdio::Stdio;
pub use termios::{ControlCharacters, Termios};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_pipe_reports_backpressure_and_binary_roundtrip() {
        let mut pipe = Pipe::bounded(3);

        assert_eq!(pipe.write(&[0, 1, 255, 4]).unwrap(), 3);
        assert_eq!(pipe.write(&[9]).unwrap_err(), PipeError::WouldBlock);
        assert_eq!(pipe.read(2).unwrap(), vec![0, 1]);
        assert_eq!(pipe.write(&[4]).unwrap(), 1);
        assert_eq!(pipe.read(8).unwrap(), vec![255, 4]);
    }

    #[test]
    fn pipe_reports_eof_and_broken_pipe() {
        let mut pipe = Pipe::bounded(4);

        pipe.close_writer();
        assert_eq!(pipe.read(1).unwrap(), Vec::<u8>::new());
        pipe.close_reader();
        assert_eq!(pipe.write(b"x").unwrap_err(), PipeError::BrokenPipe);
    }
}
