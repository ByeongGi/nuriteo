use std::{
    collections::VecDeque,
    error::Error,
    fmt::{self, Display, Formatter},
};

/// Why a pipe read or write failed.
#[must_use]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PipeError {
    /// The peer is closed, so the write cannot finish.
    BrokenPipe,
    /// The bounded buffer cannot accept or produce bytes now.
    WouldBlock,
}

impl Display for PipeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::BrokenPipe => "pipe peer is closed",
            Self::WouldBlock => "pipe operation would block",
        })
    }
}

impl Error for PipeError {}

/// Pipe operation result alias.
pub type PipeResult<T> = Result<T, PipeError>;

/// Bounded one-way byte pipe.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Pipe {
    capacity: usize,
    buffer: VecDeque<u8>,
    reader_open: bool,
    writer_open: bool,
}

impl Pipe {
    /// Creates a buffer that holds at most `capacity` bytes.
    #[must_use]
    pub fn bounded(capacity: usize) -> Self {
        Self {
            capacity,
            buffer: VecDeque::new(),
            reader_open: true,
            writer_open: true,
        }
    }

    /// Writes bytes until the pipe is full or the reader is closed.
    ///
    /// # Errors
    /// Returns [`PipeError::BrokenPipe`] when the reader is closed and
    /// [`PipeError::WouldBlock`] when the buffer has no free byte.
    pub fn write(&mut self, bytes: &[u8]) -> PipeResult<usize> {
        if !self.reader_open {
            return Err(PipeError::BrokenPipe);
        }
        let available = self.capacity.saturating_sub(self.buffer.len());
        if available == 0 {
            return Err(PipeError::WouldBlock);
        }
        let written = available.min(bytes.len());
        self.buffer.extend(&bytes[..written]);
        Ok(written)
    }

    /// Reads up to `len` bytes from the pipe.
    ///
    /// # Errors
    /// This implementation does not fail. An empty buffer returns an empty
    /// vector whether or not the writer is still open.
    pub fn read(&mut self, len: usize) -> PipeResult<Vec<u8>> {
        let count = len.min(self.buffer.len());
        if count == 0 && !self.writer_open {
            return Ok(Vec::new());
        }
        Ok(self.buffer.drain(..count).collect())
    }

    /// Marks the read end closed.
    pub fn close_reader(&mut self) {
        self.reader_open = false;
    }

    /// Marks the write end closed.
    pub fn close_writer(&mut self) {
        self.writer_open = false;
    }
}
