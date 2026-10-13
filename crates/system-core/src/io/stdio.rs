use super::pipe::Pipe;

#[derive(Debug, Clone)]
pub struct Stdio {
    pub stdin: Pipe,
    pub stdout: Pipe,
    pub stderr: Pipe,
}

impl Stdio {
    pub fn bounded(capacity: usize) -> Self {
        Self {
            stdin: Pipe::bounded(capacity),
            stdout: Pipe::bounded(capacity),
            stderr: Pipe::bounded(capacity),
        }
    }
}
