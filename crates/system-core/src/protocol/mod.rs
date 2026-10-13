pub mod generated;

use generated::{ABI_VERSION, HEADER_LENGTH, MAGIC, MAX_PAYLOAD_LENGTH, errors, opcodes, status};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireError {
    BadMessage(&'static str),
    Invalid(&'static str),
    NotImplemented(u16),
    PayloadTooLarge,
}

impl WireError {
    pub fn code(&self) -> u16 {
        match self {
            WireError::BadMessage(_) => errors::EBADMSG,
            WireError::Invalid(_) => errors::EINVAL,
            WireError::NotImplemented(_) => errors::ENOSYS,
            WireError::PayloadTooLarge => errors::E2BIG,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireFrame<'a> {
    pub request_id: u32,
    pub generation: u32,
    pub pid: u32,
    pub opcode: u16,
    pub status: u16,
    pub payload: &'a [u8],
}

fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

fn known_opcode(opcode: u16) -> bool {
    matches!(
        opcode,
        opcodes::PING
            | opcodes::FS_OPEN
            | opcodes::FS_READ
            | opcodes::FS_WRITE
            | opcodes::FS_CLOSE
            | opcodes::FS_STAT
            | opcodes::FS_MKDIR
            | opcodes::PROCESS_REGISTER
            | opcodes::PROCESS_SIGNAL_TAKE
            | opcodes::PROCESS_EXIT
            | opcodes::PTY_OPEN
            | opcodes::PTY_READ
            | opcodes::PTY_WRITE
            | opcodes::PTY_CLOSE
            | opcodes::PTY_IOCTL
            | opcodes::PTY_POLL
            | opcodes::PTY_ATTACH
            | opcodes::PTY_SETFOREGROUND
            | opcodes::PTY_DISPATCHEVENT
    )
}

pub fn decode_frame(bytes: &[u8]) -> Result<WireFrame<'_>, WireError> {
    if bytes.len() < HEADER_LENGTH {
        return Err(WireError::BadMessage("frame is shorter than header"));
    }

    let magic = read_u32(bytes, 0);
    let abi_version = read_u16(bytes, 4);
    let header_length = read_u16(bytes, 6) as usize;
    let opcode = read_u16(bytes, 20);
    let payload_length = read_u32(bytes, 24) as usize;
    let reserved = read_u32(bytes, 28);

    if magic != MAGIC {
        return Err(WireError::BadMessage("bad wire magic"));
    }
    if abi_version != ABI_VERSION {
        return Err(WireError::Invalid("unsupported ABI version"));
    }
    if header_length != HEADER_LENGTH {
        return Err(WireError::BadMessage("bad header length"));
    }
    if payload_length > MAX_PAYLOAD_LENGTH {
        return Err(WireError::PayloadTooLarge);
    }
    if bytes.len() != HEADER_LENGTH + payload_length {
        return Err(WireError::BadMessage(
            "payload length does not match frame length",
        ));
    }
    if reserved != 0 {
        return Err(WireError::BadMessage("reserved field must be zero"));
    }
    if !known_opcode(opcode) {
        return Err(WireError::NotImplemented(opcode));
    }

    Ok(WireFrame {
        request_id: read_u32(bytes, 8),
        generation: read_u32(bytes, 12),
        pid: read_u32(bytes, 16),
        opcode,
        status: read_u16(bytes, 22),
        payload: &bytes[HEADER_LENGTH..],
    })
}

pub fn decode_request(bytes: &[u8]) -> Result<WireFrame<'_>, WireError> {
    let frame = decode_frame(bytes)?;
    if frame.status != status::REQUEST {
        return Err(WireError::BadMessage("request status must be request"));
    }
    Ok(frame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use generated::GOLDEN_REQUEST_HEX;

    fn hex_to_bytes(hex: &str) -> Vec<u8> {
        assert_eq!(hex.len() % 2, 0);
        (0..hex.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn decodes_golden_request() {
        let bytes = hex_to_bytes(GOLDEN_REQUEST_HEX);
        let frame = decode_request(&bytes).expect("golden request decodes");

        assert_eq!(frame.request_id, 0x01020304);
        assert_eq!(frame.generation, 5);
        assert_eq!(frame.pid, 42);
        assert_eq!(frame.opcode, opcodes::PING);
        assert_eq!(frame.status, status::REQUEST);
        assert_eq!(frame.payload, b"hi");
    }

    #[test]
    fn rejects_bad_length() {
        let bytes = hex_to_bytes(GOLDEN_REQUEST_HEX);
        let error = decode_request(&bytes[..bytes.len() - 1]).unwrap_err();

        assert_eq!(error.code(), errors::EBADMSG);
    }

    #[test]
    fn rejects_unknown_opcode() {
        let mut bytes = hex_to_bytes(GOLDEN_REQUEST_HEX);
        bytes[20] = 0xff;
        bytes[21] = 0xff;
        let error = decode_request(&bytes).unwrap_err();

        assert_eq!(error, WireError::NotImplemented(0xffff));
        assert_eq!(error.code(), errors::ENOSYS);
    }

    #[test]
    fn rejects_bad_abi_version() {
        let mut bytes = hex_to_bytes(GOLDEN_REQUEST_HEX);
        bytes[4] = 2;
        let error = decode_request(&bytes).unwrap_err();

        assert_eq!(error.code(), errors::EINVAL);
    }
}
