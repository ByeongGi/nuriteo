use std::collections::BTreeMap;

use system_core::{
    fs::Fd,
    io::{IoError, IoctlRequest, IoctlResponse, KernelIo, PtyId, PtyLimits, TerminalSize, Termios},
    process::{Pid, ProcessError, ProcessGroupId, ProcessTable, VirtualSignal},
    protocol::{
        WireError, WireFrame,
        generated::{errors, opcodes},
    },
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchError {
    pub code: u16,
    pub message: &'static str,
}

impl DispatchError {
    fn invalid(message: &'static str) -> Self {
        Self {
            code: errors::EINVAL,
            message,
        }
    }
}

impl From<IoError> for DispatchError {
    fn from(error: IoError) -> Self {
        let code = match error {
            IoError::InvalidFd => errors::EBADF,
            IoError::Pty(system_core::io::PtyError::WouldBlock)
            | IoError::DescriptorExhausted
            | IoError::PtyExhausted => errors::EAGAIN,
            IoError::NotTerminal
            | IoError::NoControllingTerminal
            | IoError::Process(_)
            | IoError::Fs(_)
            | IoError::Pty(_) => errors::EINVAL,
        };
        Self {
            code,
            message: "I/O dispatch failed",
        }
    }
}

impl From<system_core::io::PtyError> for DispatchError {
    fn from(error: system_core::io::PtyError) -> Self {
        IoError::Pty(error).into()
    }
}

impl From<ProcessError> for DispatchError {
    fn from(error: ProcessError) -> Self {
        Self {
            code: match error {
                ProcessError::NotFound => errors::EBADF,
                ProcessError::InvalidProcessGroup
                | ProcessError::InvalidSession
                | ProcessError::InvalidTransition => errors::EINVAL,
            },
            message: "process dispatch failed",
        }
    }
}

impl From<WireError> for DispatchError {
    fn from(error: WireError) -> Self {
        Self {
            code: error.code(),
            message: "invalid wire request",
        }
    }
}

#[derive(Debug, Default)]
pub struct SystemDispatcher {
    io: KernelIo,
    processes: ProcessTable,
}

impl SystemDispatcher {
    pub fn dispatch(&mut self, frame: &WireFrame<'_>) -> Result<Vec<u8>, DispatchError> {
        match frame.opcode {
            opcodes::PING => Ok(frame.payload.to_vec()),
            opcodes::PROCESS_REGISTER => self.register_process(frame.payload),
            opcodes::PROCESS_SIGNAL_TAKE => self.take_signal(Pid(frame.pid), frame.payload),
            opcodes::PROCESS_EXIT => self.exit_process(Pid(frame.pid), frame.payload),
            opcodes::PTY_OPEN => self.open_pty(Pid(frame.pid), frame.payload),
            opcodes::PTY_READ => self.read(Pid(frame.pid), frame.payload),
            opcodes::PTY_WRITE => self.write(Pid(frame.pid), frame.payload),
            opcodes::PTY_CLOSE => self.close(Pid(frame.pid), frame.payload),
            opcodes::PTY_IOCTL => self.ioctl(Pid(frame.pid), frame.payload),
            opcodes::PTY_POLL => self.poll(Pid(frame.pid), frame.payload),
            opcodes::PTY_ATTACH => self.attach(Pid(frame.pid), frame.payload),
            opcodes::PTY_SETFOREGROUND => self.set_foreground(Pid(frame.pid), frame.payload),
            opcodes::PTY_DISPATCHEVENT => self.dispatch_event(frame.payload),
            _ => Err(DispatchError {
                code: errors::ENOSYS,
                message: "unsupported opcode",
            }),
        }
    }

    fn register_process(&mut self, payload: &[u8]) -> Result<Vec<u8>, DispatchError> {
        let mut payload = Payload::new(payload);
        let parent = match payload.u32()? {
            0 => None,
            pid => Some(Pid(pid)),
        };
        let cwd = payload.remaining_utf8()?;
        if let Some(parent) = parent {
            self.processes.get(parent)?;
        }
        let process = self.processes.prepare(
            parent,
            if cwd.is_empty() { "/workspace" } else { cwd },
            BTreeMap::new(),
        );
        let mut response = Vec::with_capacity(16);
        for value in [
            process.pid.0,
            process.generation.0,
            process.process_group.0,
            process.session.0,
        ] {
            push_u32(&mut response, value);
        }
        Ok(response)
    }

    fn take_signal(&mut self, pid: Pid, payload: &[u8]) -> Result<Vec<u8>, DispatchError> {
        require_empty(payload)?;
        Ok(vec![
            self.processes.take_signal(pid)?.map_or(0, signal_code),
        ])
    }

    fn exit_process(&mut self, pid: Pid, payload: &[u8]) -> Result<Vec<u8>, DispatchError> {
        let mut payload = Payload::new(payload);
        let exit_code = payload.i32()?;
        payload.finish()?;
        self.io.close_process(pid)?;
        self.processes.exit(pid, exit_code)?;
        Ok(Vec::new())
    }

    fn open_pty(&mut self, master_pid: Pid, payload: &[u8]) -> Result<Vec<u8>, DispatchError> {
        self.processes.get(master_pid)?;
        let mut payload = Payload::new(payload);
        let slave_pid = Pid(payload.u32()?);
        self.processes.get(slave_pid)?;
        let limits = PtyLimits::new(
            payload.u32()? as usize,
            payload.u32()? as usize,
            payload.u32()? as usize,
        )?;
        payload.finish()?;
        let pair = self
            .io
            .open_pty(master_pid, slave_pid, limits, Termios::default())?;
        let mut response = Vec::with_capacity(12);
        for value in [pair.id.0, pair.master_fd.0, pair.slave_fd.0] {
            push_u32(&mut response, value);
        }
        Ok(response)
    }

    fn read(&mut self, pid: Pid, payload: &[u8]) -> Result<Vec<u8>, DispatchError> {
        let mut payload = Payload::new(payload);
        let fd = Fd(payload.u32()?);
        let max_bytes = payload.u32()? as usize;
        payload.finish()?;
        let read = self.io.read(pid, fd, max_bytes)?;
        let mut response = Vec::with_capacity(read.bytes.len() + 1);
        response.push(u8::from(read.eof));
        response.extend(read.bytes);
        Ok(response)
    }

    fn write(&mut self, pid: Pid, payload: &[u8]) -> Result<Vec<u8>, DispatchError> {
        let mut payload = Payload::new(payload);
        let fd = Fd(payload.u32()?);
        let written = self.io.write(pid, fd, payload.remaining())?;
        Ok((written as u32).to_le_bytes().to_vec())
    }

    fn close(&mut self, pid: Pid, payload: &[u8]) -> Result<Vec<u8>, DispatchError> {
        let mut payload = Payload::new(payload);
        let fd = Fd(payload.u32()?);
        payload.finish()?;
        self.io.close(pid, fd)?;
        Ok(Vec::new())
    }

    fn ioctl(&mut self, pid: Pid, payload: &[u8]) -> Result<Vec<u8>, DispatchError> {
        let mut payload = Payload::new(payload);
        let fd = Fd(payload.u32()?);
        let request = match payload.u8()? {
            0 => IoctlRequest::GetTermios,
            1 => IoctlRequest::SetTermios(decode_termios(&mut payload)?),
            2 => IoctlRequest::GetTerminalSize,
            3 => IoctlRequest::SetTerminalSize(TerminalSize::new(payload.u16()?, payload.u16()?)?),
            _ => return Err(DispatchError::invalid("unknown ioctl operation")),
        };
        payload.finish()?;
        Ok(match self.io.ioctl(pid, fd, request)? {
            IoctlResponse::None => Vec::new(),
            IoctlResponse::Termios(termios) => encode_termios(termios),
            IoctlResponse::TerminalSize(size) => {
                let mut bytes = size.columns.to_le_bytes().to_vec();
                bytes.extend(size.rows.to_le_bytes());
                bytes
            }
        })
    }

    fn poll(&self, pid: Pid, payload: &[u8]) -> Result<Vec<u8>, DispatchError> {
        let mut payload = Payload::new(payload);
        let state = self.io.poll(pid, Fd(payload.u32()?))?;
        payload.finish()?;
        Ok(vec![
            u8::from(state.readable)
                | (u8::from(state.writable) << 1)
                | (u8::from(state.hangup) << 2)
                | (u8::from(state.priority) << 3),
        ])
    }

    fn attach(&mut self, pid: Pid, payload: &[u8]) -> Result<Vec<u8>, DispatchError> {
        let mut payload = Payload::new(payload);
        let id = PtyId(payload.u32()?);
        payload.finish()?;
        let control = self
            .io
            .attach_controlling_terminal(&self.processes, pid, id)?;
        let mut response = Vec::with_capacity(8);
        push_u32(&mut response, control.session.0);
        push_u32(&mut response, control.foreground_process_group.0);
        Ok(response)
    }

    fn set_foreground(&mut self, pid: Pid, payload: &[u8]) -> Result<Vec<u8>, DispatchError> {
        let mut payload = Payload::new(payload);
        let id = PtyId(payload.u32()?);
        let process_group = ProcessGroupId(payload.u32()?);
        payload.finish()?;
        self.io
            .set_foreground_process_group(&self.processes, pid, id, process_group)?;
        Ok(Vec::new())
    }

    fn dispatch_event(&mut self, payload: &[u8]) -> Result<Vec<u8>, DispatchError> {
        let mut payload = Payload::new(payload);
        let id = PtyId(payload.u32()?);
        payload.finish()?;
        let deliveries = self.io.dispatch_terminal_event(&mut self.processes, id)?;
        let mut response = Vec::with_capacity(4 + deliveries.len() * 9);
        push_u32(&mut response, deliveries.len() as u32);
        for delivery in deliveries {
            push_u32(&mut response, delivery.pid.0);
            push_u32(&mut response, delivery.generation.0);
            response.push(signal_code(delivery.signal));
        }
        Ok(response)
    }
}

fn decode_termios(payload: &mut Payload<'_>) -> Result<Termios, DispatchError> {
    let flags = payload.u8()?;
    let mut termios = Termios {
        canonical: flags & 1 != 0,
        echo: flags & 2 != 0,
        signals: flags & 4 != 0,
        map_cr_to_newline: flags & 8 != 0,
        ..Termios::default()
    };
    termios.control.erase = payload.u8()?;
    termios.control.kill = payload.u8()?;
    termios.control.eof = payload.u8()?;
    termios.control.interrupt = payload.u8()?;
    Ok(termios)
}

fn encode_termios(termios: Termios) -> Vec<u8> {
    vec![
        u8::from(termios.canonical)
            | (u8::from(termios.echo) << 1)
            | (u8::from(termios.signals) << 2)
            | (u8::from(termios.map_cr_to_newline) << 3),
        termios.control.erase,
        termios.control.kill,
        termios.control.eof,
        termios.control.interrupt,
    ]
}

fn signal_code(signal: VirtualSignal) -> u8 {
    match signal {
        VirtualSignal::Interrupt => 1,
        VirtualSignal::Terminate => 2,
        VirtualSignal::Kill => 3,
        VirtualSignal::WindowChanged => 4,
    }
}

fn push_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend(value.to_le_bytes());
}

fn require_empty(payload: &[u8]) -> Result<(), DispatchError> {
    if payload.is_empty() {
        Ok(())
    } else {
        Err(DispatchError::invalid("unexpected payload"))
    }
}

struct Payload<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Payload<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }
    fn u8(&mut self) -> Result<u8, DispatchError> {
        let value = *self
            .bytes
            .get(self.offset)
            .ok_or_else(|| DispatchError::invalid("payload is truncated"))?;
        self.offset += 1;
        Ok(value)
    }
    fn u16(&mut self) -> Result<u16, DispatchError> {
        Ok(u16::from_le_bytes(self.take::<2>()?))
    }
    fn u32(&mut self) -> Result<u32, DispatchError> {
        Ok(u32::from_le_bytes(self.take::<4>()?))
    }
    fn i32(&mut self) -> Result<i32, DispatchError> {
        Ok(i32::from_le_bytes(self.take::<4>()?))
    }
    fn remaining(&mut self) -> &'a [u8] {
        let remaining = &self.bytes[self.offset..];
        self.offset = self.bytes.len();
        remaining
    }
    fn remaining_utf8(&mut self) -> Result<&'a str, DispatchError> {
        std::str::from_utf8(self.remaining())
            .map_err(|_| DispatchError::invalid("payload text is not UTF-8"))
    }
    fn finish(self) -> Result<(), DispatchError> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err(DispatchError::invalid("payload has trailing bytes"))
        }
    }
    fn take<const N: usize>(&mut self) -> Result<[u8; N], DispatchError> {
        let end = self
            .offset
            .checked_add(N)
            .ok_or_else(|| DispatchError::invalid("payload offset overflow"))?;
        let bytes = self
            .bytes
            .get(self.offset..end)
            .ok_or_else(|| DispatchError::invalid("payload is truncated"))?;
        self.offset = end;
        bytes
            .try_into()
            .map_err(|_| DispatchError::invalid("payload has invalid width"))
    }
}

pub fn ping_opcode() -> u16 {
    opcodes::PING
}

#[cfg(test)]
mod tests {
    use super::*;
    use system_core::protocol::generated::status;

    fn frame(pid: u32, opcode: u16, payload: &[u8]) -> WireFrame<'_> {
        WireFrame {
            request_id: 1,
            generation: 1,
            pid,
            opcode,
            status: status::REQUEST,
            payload,
        }
    }

    fn register(dispatcher: &mut SystemDispatcher, parent: u32) -> u32 {
        let mut payload = parent.to_le_bytes().to_vec();
        payload.extend(b"/workspace");
        let response = dispatcher
            .dispatch(&frame(0, opcodes::PROCESS_REGISTER, &payload))
            .unwrap();
        u32::from_le_bytes(response[0..4].try_into().unwrap())
    }

    #[test]
    fn exposes_ping_dispatch_opcode() {
        assert_eq!(ping_opcode(), 1);
    }

    #[test]
    fn dispatches_pty_io_and_terminal_signals() {
        let mut dispatcher = SystemDispatcher::default();
        let host = register(&mut dispatcher, 0);
        let guest = register(&mut dispatcher, host);
        let mut open = Vec::new();
        for value in [guest, 64, 64, 8] {
            push_u32(&mut open, value);
        }
        let pair = dispatcher
            .dispatch(&frame(host, opcodes::PTY_OPEN, &open))
            .unwrap();
        let pty = u32::from_le_bytes(pair[0..4].try_into().unwrap());
        let master_fd = u32::from_le_bytes(pair[4..8].try_into().unwrap());
        let slave_fd = u32::from_le_bytes(pair[8..12].try_into().unwrap());

        let mut write = master_fd.to_le_bytes().to_vec();
        write.extend(b"hello\r");
        assert_eq!(
            dispatcher
                .dispatch(&frame(host, opcodes::PTY_WRITE, &write))
                .unwrap(),
            6_u32.to_le_bytes()
        );
        let mut read = slave_fd.to_le_bytes().to_vec();
        read.extend(32_u32.to_le_bytes());
        assert_eq!(
            dispatcher
                .dispatch(&frame(guest, opcodes::PTY_READ, &read))
                .unwrap(),
            b"\0hello\n"
        );

        dispatcher
            .dispatch(&frame(host, opcodes::PTY_ATTACH, &pty.to_le_bytes()))
            .unwrap();
        let mut interrupt = master_fd.to_le_bytes().to_vec();
        interrupt.push(3);
        dispatcher
            .dispatch(&frame(host, opcodes::PTY_WRITE, &interrupt))
            .unwrap();
        let deliveries = dispatcher
            .dispatch(&frame(host, opcodes::PTY_DISPATCHEVENT, &pty.to_le_bytes()))
            .unwrap();
        assert_eq!(u32::from_le_bytes(deliveries[0..4].try_into().unwrap()), 2);
        assert_eq!(
            dispatcher
                .dispatch(&frame(guest, opcodes::PROCESS_SIGNAL_TAKE, &[]))
                .unwrap(),
            vec![1]
        );
    }
}
