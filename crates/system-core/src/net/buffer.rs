use std::{
    collections::VecDeque,
    error::Error,
    fmt::{self, Display, Formatter},
};

/// Why a network buffer write failed.
#[must_use]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NetBufferError {
    /// The bounded queue cannot accept more bytes now.
    WouldBlock,
}

impl Display for NetBufferError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::WouldBlock => "network buffer operation would block",
        })
    }
}

impl Error for NetBufferError {}

/// Bounded byte queue for one connection direction.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct NetBuffer {
    capacity: usize,
    bytes: VecDeque<u8>,
}

impl NetBuffer {
    /// Creates a buffer that holds at most `capacity` bytes.
    #[must_use]
    pub fn bounded(capacity: usize) -> Self {
        Self {
            capacity,
            bytes: VecDeque::new(),
        }
    }

    /// Appends bytes until the buffer is full.
    ///
    /// # Errors
    /// Returns [`NetBufferError::WouldBlock`] when the buffer has no free byte.
    /// A short write returns `Ok` with the number of bytes that fit.
    pub fn write(&mut self, input: &[u8]) -> Result<usize, NetBufferError> {
        let available = self.capacity.saturating_sub(self.bytes.len());
        if available == 0 {
            return Err(NetBufferError::WouldBlock);
        }
        let written = available.min(input.len());
        self.bytes.extend(&input[..written]);
        Ok(written)
    }

    /// Removes up to `len` buffered bytes.
    #[must_use]
    pub fn read(&mut self, len: usize) -> Vec<u8> {
        let count = len.min(self.bytes.len());
        self.bytes.drain(..count).collect()
    }
}
