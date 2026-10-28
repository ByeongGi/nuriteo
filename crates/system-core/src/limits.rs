use std::{
    error::Error,
    fmt::{self, Display, Formatter},
};

/// Which resource quota a reservation exceeded.
#[must_use]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LimitError {
    /// The filesystem byte quota has no room for the reservation.
    VfsBytesExceeded,
    /// The process count quota has no room for another process.
    ProcessCountExceeded,
    /// The buffer byte quota has no room for the reservation.
    BufferBytesExceeded,
    /// The connection count quota has no room for another connection.
    ConnectionCountExceeded,
}

impl Display for LimitError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::VfsBytesExceeded => "vfs byte limit exceeded",
            Self::ProcessCountExceeded => "process count limit exceeded",
            Self::BufferBytesExceeded => "buffer byte limit exceeded",
            Self::ConnectionCountExceeded => "connection count limit exceeded",
        })
    }
}

impl Error for LimitError {}

/// Maximum counts the resource limiter will admit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ResourceLimitConfig {
    /// Most filesystem bytes a reservation may reach.
    pub max_vfs_bytes: usize,
    /// Most processes a reservation may reach.
    pub max_processes: usize,
    /// Most buffer bytes a reservation may reach.
    pub max_buffer_bytes: usize,
    /// Most connections a reservation may reach.
    pub max_connections: usize,
}

/// Resources currently reserved by the limiter.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ResourceUsage {
    /// Filesystem bytes reserved so far.
    pub vfs_bytes: usize,
    /// Process slots reserved so far.
    pub processes: usize,
    /// Buffer bytes reserved so far.
    pub buffer_bytes: usize,
    /// Connection slots reserved so far.
    pub connections: usize,
}

/// Counter that rejects reservations past a configured maximum.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ResourceLimiter {
    config: ResourceLimitConfig,
    usage: ResourceUsage,
}

impl ResourceLimiter {
    /// Creates a limiter with zero usage and the given maxima.
    #[must_use]
    pub fn new(config: ResourceLimitConfig) -> Self {
        Self {
            config,
            usage: ResourceUsage::default(),
        }
    }

    /// Returns the resources reserved so far.
    #[must_use]
    pub fn usage(&self) -> ResourceUsage {
        self.usage
    }

    /// Reserves filesystem bytes or reports that the quota is full.
    ///
    /// # Errors
    /// Returns [`LimitError::VfsBytesExceeded`] when `amount` does not fit in the remaining quota.
    pub fn reserve_vfs_bytes(&mut self, amount: usize) -> Result<(), LimitError> {
        self.reserve(
            amount,
            |usage| &mut usage.vfs_bytes,
            self.config.max_vfs_bytes,
            LimitError::VfsBytesExceeded,
        )
    }

    /// Returns previously reserved filesystem bytes.
    pub fn release_vfs_bytes(&mut self, amount: usize) {
        self.usage.vfs_bytes = self.usage.vfs_bytes.saturating_sub(amount);
    }

    /// Reserves one process slot or reports that the quota is full.
    ///
    /// # Errors
    /// Returns [`LimitError::ProcessCountExceeded`] when no process slot remains.
    pub fn reserve_process(&mut self) -> Result<(), LimitError> {
        self.reserve(
            1,
            |usage| &mut usage.processes,
            self.config.max_processes,
            LimitError::ProcessCountExceeded,
        )
    }

    /// Returns one reserved process slot.
    pub fn release_process(&mut self) {
        self.usage.processes = self.usage.processes.saturating_sub(1);
    }

    /// Reserves buffer bytes or reports that the quota is full.
    ///
    /// # Errors
    /// Returns [`LimitError::BufferBytesExceeded`] when `amount` does not fit in the remaining quota.
    pub fn reserve_buffer_bytes(&mut self, amount: usize) -> Result<(), LimitError> {
        self.reserve(
            amount,
            |usage| &mut usage.buffer_bytes,
            self.config.max_buffer_bytes,
            LimitError::BufferBytesExceeded,
        )
    }

    /// Returns previously reserved buffer bytes.
    pub fn release_buffer_bytes(&mut self, amount: usize) {
        self.usage.buffer_bytes = self.usage.buffer_bytes.saturating_sub(amount);
    }

    /// Reserves one connection slot or reports that the quota is full.
    ///
    /// # Errors
    /// Returns [`LimitError::ConnectionCountExceeded`] when no connection slot remains.
    pub fn reserve_connection(&mut self) -> Result<(), LimitError> {
        self.reserve(
            1,
            |usage| &mut usage.connections,
            self.config.max_connections,
            LimitError::ConnectionCountExceeded,
        )
    }

    /// Returns one reserved connection slot.
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
