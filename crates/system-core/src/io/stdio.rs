use super::pipe::Pipe;

/// Bounded buffer standing in for a standard stream.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Stdio {
    /// Bytes a process reads as standard input.
    pub stdin: Pipe,
    /// Bytes a process writes as standard output.
    pub stdout: Pipe,
    /// Bytes a process writes as standard error.
    pub stderr: Pipe,
}

impl Stdio {
    /// Creates a buffer that holds at most `capacity` bytes.
    #[must_use]
    pub fn bounded(capacity: usize) -> Self {
        Self {
            stdin: Pipe::bounded(capacity),
            stdout: Pipe::bounded(capacity),
            stderr: Pipe::bounded(capacity),
        }
    }
}
