use std::collections::VecDeque;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PipeError {
    BrokenPipe,
    WouldBlock,
}

pub type PipeResult<T> = Result<T, PipeError>;

#[derive(Debug, Clone)]
pub struct Pipe {
    capacity: usize,
    buffer: VecDeque<u8>,
    reader_open: bool,
    writer_open: bool,
}

impl Pipe {
    pub fn bounded(capacity: usize) -> Self {
        Self {
            capacity,
            buffer: VecDeque::new(),
            reader_open: true,
            writer_open: true,
        }
    }

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

    pub fn read(&mut self, len: usize) -> PipeResult<Vec<u8>> {
        let count = len.min(self.buffer.len());
        if count == 0 && !self.writer_open {
            return Ok(Vec::new());
        }
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            if let Some(byte) = self.buffer.pop_front() {
                out.push(byte);
            }
        }
        Ok(out)
    }

    pub fn close_reader(&mut self) {
        self.reader_open = false;
    }

    pub fn close_writer(&mut self) {
        self.writer_open = false;
    }
}
