#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitError {
    VfsBytesExceeded,
    ProcessCountExceeded,
    BufferBytesExceeded,
    ConnectionCountExceeded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceLimitConfig {
    pub max_vfs_bytes: usize,
    pub max_processes: usize,
    pub max_buffer_bytes: usize,
    pub max_connections: usize,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ResourceUsage {
    pub vfs_bytes: usize,
    pub processes: usize,
    pub buffer_bytes: usize,
    pub connections: usize,
}

#[derive(Debug, Clone)]
pub struct ResourceLimiter {
    config: ResourceLimitConfig,
    usage: ResourceUsage,
}

impl ResourceLimiter {
    pub fn new(config: ResourceLimitConfig) -> Self {
        Self {
            config,
            usage: ResourceUsage::default(),
        }
    }

    pub fn usage(&self) -> ResourceUsage {
        self.usage
    }

    pub fn reserve_vfs_bytes(&mut self, amount: usize) -> Result<(), LimitError> {
        self.reserve(
            amount,
            |usage| &mut usage.vfs_bytes,
            self.config.max_vfs_bytes,
            LimitError::VfsBytesExceeded,
        )
    }

    pub fn release_vfs_bytes(&mut self, amount: usize) {
        self.usage.vfs_bytes = self.usage.vfs_bytes.saturating_sub(amount);
    }

    pub fn reserve_process(&mut self) -> Result<(), LimitError> {
        self.reserve(
            1,
            |usage| &mut usage.processes,
            self.config.max_processes,
            LimitError::ProcessCountExceeded,
        )
    }

    pub fn release_process(&mut self) {
        self.usage.processes = self.usage.processes.saturating_sub(1);
    }

    pub fn reserve_buffer_bytes(&mut self, amount: usize) -> Result<(), LimitError> {
        self.reserve(
            amount,
            |usage| &mut usage.buffer_bytes,
            self.config.max_buffer_bytes,
            LimitError::BufferBytesExceeded,
        )
    }

    pub fn release_buffer_bytes(&mut self, amount: usize) {
        self.usage.buffer_bytes = self.usage.buffer_bytes.saturating_sub(amount);
    }

    pub fn reserve_connection(&mut self) -> Result<(), LimitError> {
        self.reserve(
            1,
            |usage| &mut usage.connections,
            self.config.max_connections,
            LimitError::ConnectionCountExceeded,
        )
    }

    pub fn release_connection(&mut self) {
        self.usage.connections = self.usage.connections.saturating_sub(1);
    }

    fn reserve(
        &mut self,
        amount: usize,
        field: impl FnOnce(&mut ResourceUsage) -> &mut usize,
        max: usize,
        error: LimitError,
    ) -> Result<(), LimitError> {
        let current = field(&mut self.usage);
        if current.saturating_add(amount) > max {
            return Err(error);
        }
        *current += amount;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_vfs_process_buffer_and_connection_limits() {
        let mut limiter = ResourceLimiter::new(ResourceLimitConfig {
            max_vfs_bytes: 4,
            max_processes: 1,
            max_buffer_bytes: 8,
            max_connections: 1,
        });

        limiter.reserve_vfs_bytes(4).unwrap();
        assert_eq!(
            limiter.reserve_vfs_bytes(1).unwrap_err(),
            LimitError::VfsBytesExceeded
        );
        limiter.release_vfs_bytes(2);
        limiter.reserve_vfs_bytes(2).unwrap();

        limiter.reserve_process().unwrap();
        assert_eq!(
            limiter.reserve_process().unwrap_err(),
            LimitError::ProcessCountExceeded
        );
        limiter.release_process();
        limiter.reserve_process().unwrap();

        limiter.reserve_buffer_bytes(8).unwrap();
        assert_eq!(
            limiter.reserve_buffer_bytes(1).unwrap_err(),
            LimitError::BufferBytesExceeded
        );

        limiter.reserve_connection().unwrap();
        assert_eq!(
            limiter.reserve_connection().unwrap_err(),
            LimitError::ConnectionCountExceeded
        );
    }
}
