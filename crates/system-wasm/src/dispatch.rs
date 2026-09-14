use system_core::protocol::generated::opcodes;

pub fn ping_opcode() -> u16 {
    opcodes::PING
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_ping_dispatch_opcode() {
        assert_eq!(ping_opcode(), 1);
    }
}
