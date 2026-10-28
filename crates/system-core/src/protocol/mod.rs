/// Wire constants produced from the protocol schema.
pub mod generated;

use std::{
    error::Error,
    fmt::{self, Display, Formatter},
};

use generated::{ABI_VERSION, HEADER_LENGTH, MAGIC, MAX_PAYLOAD_LENGTH, errors, opcodes, status};

/// Why a guest frame was rejected.
#[must_use]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WireError {
    /// The frame bytes break a structural rule. The string is the guest sentence.
    BadMessage(&'static str),
    /// The frame is structurally readable but not acceptable. The string is the guest sentence.
    Invalid(&'static str),
    /// The opcode is outside the implemented set.
    NotImplemented(u16),
    /// The declared payload is longer than the ABI maximum.
    PayloadTooLarge,
}

impl Display for WireError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadMessage(message) | Self::Invalid(message) => formatter.write_str(message),
            Self::NotImplemented(opcode) => {
                write!(formatter, "opcode {opcode} is not implemented")
            }
            Self::PayloadTooLarge => formatter.write_str("payload exceeds the maximum length"),
        }
    }
}

impl Error for WireError {}

impl WireError {
    /// Static guest sentence for this decode failure.
    ///
    /// [`WireError::NotImplemented`] keeps one stable generic sentence because
    /// the opcode number is not a fixed string.
    #[must_use]
    pub const fn guest_message(&self) -> &'static str {
        match self {
            Self::BadMessage(message) | Self::Invalid(message) => message,
            Self::PayloadTooLarge => "payload exceeds the maximum length",
            Self::NotImplemented(_) => "invalid wire request",
        }
    }

    /// Returns the numeric errno for this decode failure.
    #[must_use]
    pub fn code(&self) -> u16 {
        match self {
            WireError::BadMessage(_) => errors::EBADMSG,
            WireError::Invalid(_) => errors::EINVAL,
            WireError::NotImplemented(_) => errors::ENOSYS,
            WireError::PayloadTooLarge => errors::E2BIG,
        }
    }
}

/// Decoded header fields and borrowed payload of one frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct WireFrame<'a> {
    /// Caller-chosen id copied into the response.
    pub request_id: u32,
    /// Guest generation copied into the response.
    pub generation: u32,
    /// Process the opcode runs as.
    pub pid: u32,
    /// Operation selected from the opcode table.
    pub opcode: u16,
    /// Request, success, or error status.
    pub status: u16,
    /// Bytes after the fixed header. The frame borrows them from the input buffer.
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

/// Decodes one header and payload, checking magic, ABI, and length.
///
/// # Errors
/// Returns [`WireError::BadMessage`] when the buffer is shorter than the header,
/// the magic or header length is wrong, the payload length does not match the
/// buffer, or the reserved field is not zero. Returns [`WireError::Invalid`] for
/// an unsupported ABI version, [`WireError::PayloadTooLarge`] above the ABI limit,
/// and [`WireError::NotImplemented`] for an unknown opcode.
pub fn decode_frame(bytes: &[u8]) -> Result<WireFrame<'_>, WireError> {
    if bytes.len() < HEADER_LENGTH {
        return Err(WireError::BadMessage("frame is shorter than header"));
    }

    let magic = read_u32(bytes, 0);
    let abi_version = read_u16(bytes, 4);
    let header_length = usize::from(read_u16(bytes, 6));
    let opcode = read_u16(bytes, 20);
    let payload_length =
        usize::try_from(read_u32(bytes, 24)).expect("wire payload length fits in usize");
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

/// Decodes a frame and requires the request status.
///
/// # Errors
/// Returns the same errors as [`decode_frame`], and [`WireError::BadMessage`]
/// when the status is not a request.
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

    #[test]
    fn displays_the_wire_reason() {
        let error = WireError::BadMessage("bad wire magic");
        assert_eq!(error.to_string(), "bad wire magic");
        let missing = WireError::NotImplemented(0xffff);
        assert_eq!(missing.to_string(), "opcode 65535 is not implemented");
    }
}
