use std::collections::VecDeque;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetBufferError {
    WouldBlock,
}

#[derive(Debug, Clone)]
pub struct NetBuffer {
    capacity: usize,
    bytes: VecDeque<u8>,
}

impl NetBuffer {
    pub fn bounded(capacity: usize) -> Self {
        Self {
            capacity,
            bytes: VecDeque::new(),
        }
    }

    pub fn write(&mut self, input: &[u8]) -> Result<usize, NetBufferError> {
        let available = self.capacity.saturating_sub(self.bytes.len());
        if available == 0 {
            return Err(NetBufferError::WouldBlock);
        }
        let written = available.min(input.len());
        self.bytes.extend(&input[..written]);
        Ok(written)
    }

    pub fn read(&mut self, len: usize) -> Vec<u8> {
        let count = len.min(self.bytes.len());
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            if let Some(byte) = self.bytes.pop_front() {
                out.push(byte);
            }
        }
        out
    }
}
