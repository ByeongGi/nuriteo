use system_core::ABI_VERSION;

pub mod dispatch;

#[unsafe(no_mangle)]
pub extern "C" fn cargo_container_abi_version() -> u32 {
    ABI_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_core_abi_version() {
        assert_eq!(cargo_container_abi_version(), 1);
    }
}
