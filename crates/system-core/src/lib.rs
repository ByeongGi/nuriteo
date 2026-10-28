//! In-memory kernel used by the Nuriteo guest ABI.
//!
//! Files, processes, pipes, and the wire protocol live here so the WASM
//! adapter can dispatch them without a host operating system.

/// In-memory filesystem shared by guest processes.
pub mod fs;
/// Pipes, PTYs, and the file-descriptor kernel.
pub mod io;
/// Byte and object quotas for one kernel instance.
pub mod limits;
/// In-memory TCP-style listeners and connections.
pub mod net;
/// Process table, sessions, and virtual signals.
pub mod process;
/// Guest ABI frames and opcode decoding.
pub mod protocol;

/// ABI version and kernel name reported to a guest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct KernelInfo {
    /// ABI version guests must send in each frame.
    pub abi_version: u32,
    /// Kernel name reported with that version.
    pub name: &'static str,
}

/// ABI version this kernel reports to guests.
pub const ABI_VERSION: u32 = 1;

/// Returns the ABI version and kernel name.
#[must_use]
pub fn kernel_info() -> KernelInfo {
    KernelInfo {
        abi_version: ABI_VERSION,
        name: "nuriteo-system",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_initial_kernel_info() {
        let info = kernel_info();

        assert_eq!(info.abi_version, 1);
        assert_eq!(info.name, "nuriteo-system");
    }
}
