//! WASM guest entry points for the Nuriteo system ABI.
//!
//! The exported functions hand a request buffer to [`dispatch::SystemDispatcher`]
//! and copy the encoded response back to the guest.

use std::cell::RefCell;

use dispatch::{DispatchError, SystemDispatcher};
use system_core::{
    ABI_VERSION,
    protocol::{
        decode_request,
        generated::{self, errors, opcodes, status},
    },
};

/// Opcode dispatch and the guest-visible error it returns.
pub mod dispatch;

thread_local! {
    static SYSTEM: RefCell<SystemDispatcher> = RefCell::new(SystemDispatcher::default());
    static REQUEST: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static RESPONSE: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Returns the guest ABI version.
///
/// The value stays valid for the process lifetime.
#[must_use]
#[unsafe(no_mangle)]
pub extern "C" fn nuriteo_abi_version() -> u32 {
    ABI_VERSION
}

/// Clears the dispatcher and both guest buffers.
///
/// Addresses previously returned by [`nuriteo_request_buffer`] and
/// [`nuriteo_response_buffer`] become invalid.
///
/// # Panics
/// Panics if the replacement filesystem cannot create `/workspace`.
#[unsafe(no_mangle)]
pub extern "C" fn nuriteo_reset() {
    SYSTEM.with(|system| *system.borrow_mut() = SystemDispatcher::default());
    REQUEST.with(|request| request.borrow_mut().clear());
    RESPONSE.with(|response| response.borrow_mut().clear());
}

/// Reserves `length` bytes in the request buffer and returns their guest address.
///
/// Returns `0` when `length` does not fit in the ABI limit or the pointer does
/// not fit in `u32`. The address is valid until the next call to this function
/// or to [`nuriteo_reset`].
#[must_use]
#[unsafe(no_mangle)]
pub extern "C" fn nuriteo_request_buffer(length: u32) -> u32 {
    let Ok(length) = usize::try_from(length) else {
        return 0;
    };
    if length > generated::MAX_PAYLOAD_LENGTH + generated::HEADER_LENGTH {
        return 0;
    }
    REQUEST.with(|request| {
        let mut request = request.borrow_mut();
        request.resize(length, 0);
        guest_address(request.as_mut_ptr())
    })
}

/// Dispatches `length` request bytes and returns the response length.
///
/// A `length` past the reserved request buffer returns an error frame instead
/// of reading past it. The response address from [`nuriteo_response_buffer`]
/// then refers to that frame.
///
/// # Panics
/// Panics when the encoded response does not fit in `u32`.
#[must_use]
#[unsafe(no_mangle)]
pub extern "C" fn nuriteo_dispatch(length: u32) -> u32 {
    let request = REQUEST.with(|request| {
        let request = request.borrow();
        usize::try_from(length)
            .ok()
            .filter(|length| *length <= request.len())
            .map(|length| request[..length].to_vec())
    });
    let response = match request {
        Some(request) => dispatch_request(&request),
        None => encode_response(
            0,
            0,
            0,
            opcodes::PING,
            status::ERROR,
            &error_payload(errors::EBADMSG, "request length exceeds buffer"),
        ),
    };
    let length = u32::try_from(response.len()).expect("wasm response length fits in u32");
    RESPONSE.with(|buffer| *buffer.borrow_mut() = response);
    length
}

/// Returns the guest address of the last response buffer.
///
/// Returns `0` when the pointer does not fit in `u32`. The address is valid
/// until the next [`nuriteo_dispatch`] or [`nuriteo_reset`].
#[must_use]
#[unsafe(no_mangle)]
pub extern "C" fn nuriteo_response_buffer() -> u32 {
    RESPONSE.with(|response| guest_address(response.borrow().as_ptr()))
}

// wasm32 pointers fit in u32. A host pointer that does not becomes 0, the
// failure sentinel `nuriteo_request_buffer` already returns.
fn guest_address(ptr: *const u8) -> u32 {
    u32::try_from(ptr as usize).unwrap_or(0)
}

fn dispatch_request(request: &[u8]) -> Vec<u8> {
    let frame = match decode_request(request) {
        Ok(frame) => frame,
        Err(error) => {
            return encode_response(
                0,
                0,
                0,
                opcodes::PING,
                status::ERROR,
                &error_payload(error.code(), error.guest_message()),
            );
        }
    };
    let result = SYSTEM.with(|system| system.borrow_mut().dispatch(&frame));
    match result {
        Ok(payload) => encode_response(
            frame.request_id,
            frame.generation,
            frame.pid,
            frame.opcode,
            status::OK,
            &payload,
        ),
        Err(DispatchError { code, message }) => encode_response(
            frame.request_id,
            frame.generation,
            frame.pid,
            frame.opcode,
            status::ERROR,
            &error_payload(code, message),
        ),
    }
}

fn error_payload(code: u16, message: &str) -> Vec<u8> {
    let mut payload = code.to_le_bytes().to_vec();
    payload.extend(message.as_bytes());
    payload
}

fn encode_response(
    request_id: u32,
    generation: u32,
    pid: u32,
    opcode: u16,
    response_status: u16,
    payload: &[u8],
) -> Vec<u8> {
    let header_length =
        u16::try_from(generated::HEADER_LENGTH).expect("ABI header length fits in u16");
    let payload_length = u32::try_from(payload.len()).expect("response payload length fits in u32");
    let mut response = Vec::with_capacity(generated::HEADER_LENGTH + payload.len());
    response.extend(generated::MAGIC.to_le_bytes());
    response.extend(generated::ABI_VERSION.to_le_bytes());
    response.extend(header_length.to_le_bytes());
    response.extend(request_id.to_le_bytes());
    response.extend(generation.to_le_bytes());
    response.extend(pid.to_le_bytes());
    response.extend(opcode.to_le_bytes());
    response.extend(response_status.to_le_bytes());
    response.extend(payload_length.to_le_bytes());
    response.extend(0_u32.to_le_bytes());
    response.extend(payload);
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use dispatch::SystemDispatcher;
    use system_core::protocol::WireFrame;

    fn header_length() -> u16 {
        u16::try_from(generated::HEADER_LENGTH).expect("ABI header length fits in u16")
    }

    fn request_frame(pid: u32, opcode: u16, payload: &[u8]) -> Vec<u8> {
        let payload_length = u32::try_from(payload.len()).expect("test payload length fits in u32");
        let mut request = Vec::new();
        request.extend(generated::MAGIC.to_le_bytes());
        request.extend(generated::ABI_VERSION.to_le_bytes());
        request.extend(header_length().to_le_bytes());
        request.extend(7_u32.to_le_bytes());
        request.extend(3_u32.to_le_bytes());
        request.extend(pid.to_le_bytes());
        request.extend(opcode.to_le_bytes());
        request.extend(status::REQUEST.to_le_bytes());
        request.extend(payload_length.to_le_bytes());
        request.extend(0_u32.to_le_bytes());
        request.extend(payload);
        request
    }

    #[test]
    fn exports_core_abi_version() {
        assert_eq!(nuriteo_abi_version(), 1);
    }

    #[test]
    fn dispatches_a_wire_ping_into_a_response_frame() {
        let response = dispatch_request(&request_frame(1, opcodes::PING, b"ping"));
        assert_eq!(&response[8..12], &7_u32.to_le_bytes());
        assert_eq!(&response[22..24], &status::OK.to_le_bytes());
        assert_eq!(&response[32..], b"ping");
    }

    #[test]
    fn guest_error_payload_keeps_the_specific_reason() {
        let mut bad_magic = request_frame(1, opcodes::PING, b"ping");
        bad_magic[..4].copy_from_slice(&0_u32.to_le_bytes());
        let decoded = dispatch_request(&bad_magic);
        let payload = &decoded[generated::HEADER_LENGTH..];
        assert!(
            payload
                .windows(b"bad wire magic".len())
                .any(|window| window == b"bad wire magic"),
            "payload {payload:?}"
        );

        nuriteo_reset();
        let missing = dispatch_request(&request_frame(9, opcodes::PROCESS_SIGNAL_TAKE, &[]));
        let payload = &missing[generated::HEADER_LENGTH..];
        assert!(
            payload
                .windows(b"process was not found".len())
                .any(|window| window == b"process was not found"),
            "payload {payload:?}"
        );
        assert_eq!(&payload[..2], &errors::EBADF.to_le_bytes());

        let mut dispatcher = SystemDispatcher::default();
        let error = dispatcher
            .dispatch(&WireFrame {
                request_id: 1,
                generation: 1,
                pid: 9,
                opcode: opcodes::PROCESS_SIGNAL_TAKE,
                status: status::REQUEST,
                payload: &[],
            })
            .expect_err("unknown pid has no pending signal");
        assert_eq!(error.code, errors::EBADF);
        assert_eq!(error.message, "process was not found");
    }
}
