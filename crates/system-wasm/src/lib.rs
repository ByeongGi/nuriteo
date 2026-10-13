use std::cell::RefCell;

use dispatch::{DispatchError, SystemDispatcher};
use system_core::{
    ABI_VERSION,
    protocol::{
        decode_request,
        generated::{self, errors, opcodes, status},
    },
};

pub mod dispatch;

thread_local! {
    static SYSTEM: RefCell<SystemDispatcher> = RefCell::new(SystemDispatcher::default());
    static REQUEST: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static RESPONSE: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[unsafe(no_mangle)]
pub extern "C" fn nuriteo_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn nuriteo_reset() {
    SYSTEM.with(|system| *system.borrow_mut() = SystemDispatcher::default());
    REQUEST.with(|request| request.borrow_mut().clear());
    RESPONSE.with(|response| response.borrow_mut().clear());
}

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
        request.as_mut_ptr() as usize as u32
    })
}

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
    let length = response.len() as u32;
    RESPONSE.with(|buffer| *buffer.borrow_mut() = response);
    length
}

#[unsafe(no_mangle)]
pub extern "C" fn nuriteo_response_buffer() -> u32 {
    RESPONSE.with(|response| response.borrow().as_ptr() as usize as u32)
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
                &error_payload(error.code(), "invalid request frame"),
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
    let mut response = Vec::with_capacity(generated::HEADER_LENGTH + payload.len());
    response.extend(generated::MAGIC.to_le_bytes());
    response.extend(generated::ABI_VERSION.to_le_bytes());
    response.extend((generated::HEADER_LENGTH as u16).to_le_bytes());
    response.extend(request_id.to_le_bytes());
    response.extend(generation.to_le_bytes());
    response.extend(pid.to_le_bytes());
    response.extend(opcode.to_le_bytes());
    response.extend(response_status.to_le_bytes());
    response.extend((payload.len() as u32).to_le_bytes());
    response.extend(0_u32.to_le_bytes());
    response.extend(payload);
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_core_abi_version() {
        assert_eq!(nuriteo_abi_version(), 1);
    }

    #[test]
    fn dispatches_a_wire_ping_into_a_response_frame() {
        let mut request = Vec::new();
        request.extend(generated::MAGIC.to_le_bytes());
        request.extend(generated::ABI_VERSION.to_le_bytes());
        request.extend((generated::HEADER_LENGTH as u16).to_le_bytes());
        request.extend(7_u32.to_le_bytes());
        request.extend(3_u32.to_le_bytes());
        request.extend(1_u32.to_le_bytes());
        request.extend(opcodes::PING.to_le_bytes());
        request.extend(status::REQUEST.to_le_bytes());
        request.extend(4_u32.to_le_bytes());
        request.extend(0_u32.to_le_bytes());
        request.extend(b"ping");

        let response = dispatch_request(&request);
        assert_eq!(&response[8..12], &7_u32.to_le_bytes());
        assert_eq!(&response[22..24], &status::OK.to_le_bytes());
        assert_eq!(&response[32..], b"ping");
    }
}
