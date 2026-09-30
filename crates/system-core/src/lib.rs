pub mod fs;
pub mod io;
pub mod limits;
pub mod net;
pub mod process;
pub mod protocol;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelInfo {
    pub abi_version: u32,
    pub name: &'static str,
}

pub const ABI_VERSION: u32 = 1;

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
