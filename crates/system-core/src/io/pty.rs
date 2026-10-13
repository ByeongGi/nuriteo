use std::{
    collections::VecDeque,
    error::Error,
    fmt::{self, Display, Formatter},
};

use super::termios::Termios;

const ERASE_ECHO: &[u8] = b"\x08 \x08";
const INTERRUPT_ECHO: &[u8] = b"^C\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PtyLimits {
    pub input_bytes: usize,
    pub output_bytes: usize,
    pub events: usize,
}

impl PtyLimits {
    pub fn new(input_bytes: usize, output_bytes: usize, events: usize) -> PtyResult<Self> {
        if input_bytes == 0 || output_bytes == 0 || events == 0 {
            return Err(PtyError::InvalidLimit);
        }
        Ok(Self {
            input_bytes,
            output_bytes,
            events,
        })
    }
}

impl Default for PtyLimits {
    fn default() -> Self {
        Self {
            input_bytes: 64 * 1024,
            output_bytes: 64 * 1024,
            events: 64,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    pub columns: u16,
    pub rows: u16,
}

impl TerminalSize {
    pub fn new(columns: u16, rows: u16) -> PtyResult<Self> {
        if columns == 0 || rows == 0 {
            return Err(PtyError::InvalidTerminalSize);
        }
        Ok(Self { columns, rows })
    }
}

impl Default for TerminalSize {
    fn default() -> Self {
        Self {
            columns: 80,
            rows: 24,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtyEvent {
    Interrupt,
    Resize(TerminalSize),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtyRead {
    pub bytes: Vec<u8>,
    pub eof: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PtyReady {
    pub readable: bool,
    pub writable: bool,
    pub hangup: bool,
    pub event: bool,
}

impl PtyRead {
    fn data(bytes: Vec<u8>) -> Self {
        Self { bytes, eof: false }
    }

    fn eof() -> Self {
        Self {
            bytes: Vec::new(),
            eof: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtyError {
    BrokenPipe,
    Closed,
    InvalidLimit,
    InvalidTerminalSize,
    WouldBlock,
}

impl Display for PtyError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::BrokenPipe => "PTY peer is closed",
            Self::Closed => "PTY endpoint is closed",
            Self::InvalidLimit => "PTY limits must be greater than zero",
            Self::InvalidTerminalSize => "PTY terminal dimensions must be greater than zero",
            Self::WouldBlock => "PTY operation would block",
        })
    }
}

impl Error for PtyError {}

pub type PtyResult<T> = Result<T, PtyError>;

/// A bounded in-memory pseudo-terminal with explicit master and slave sides.
///
/// The master side represents a terminal emulator such as xterm.js. The slave
/// side represents a guest process. This type is deliberately independent of
/// file descriptors and WASM dispatch; those adapters can reference a PTY by ID
/// without changing its line-discipline invariants.
#[derive(Debug)]
pub struct VirtualPty {
    limits: PtyLimits,
    termios: Termios,
    size: TerminalSize,
    slave_input: VecDeque<u8>,
    master_output: VecDeque<u8>,
    canonical_input: Vec<u8>,
    eof_markers: VecDeque<usize>,
    events: VecDeque<PtyEvent>,
    master_open: bool,
    slave_open: bool,
}

impl VirtualPty {
    pub fn new(limits: PtyLimits, termios: Termios) -> PtyResult<Self> {
        let limits = PtyLimits::new(limits.input_bytes, limits.output_bytes, limits.events)?;
        Ok(Self {
            limits,
            termios,
            size: TerminalSize::default(),
            slave_input: VecDeque::new(),
            master_output: VecDeque::new(),
            canonical_input: Vec::new(),
            eof_markers: VecDeque::new(),
            events: VecDeque::new(),
            master_open: true,
            slave_open: true,
        })
    }

    pub fn termios(&self) -> Termios {
        self.termios
    }

    pub fn set_termios(&mut self, termios: Termios) -> PtyResult<()> {
        if self.termios.canonical && !termios.canonical && !self.canonical_input.is_empty() {
            self.flush_canonical()?;
        }
        self.termios = termios;
        Ok(())
    }

    pub fn terminal_size(&self) -> TerminalSize {
        self.size
    }

    pub fn resize(&mut self, size: TerminalSize) -> PtyResult<()> {
        let size = TerminalSize::new(size.columns, size.rows)?;
        if self.events.len() >= self.limits.events {
            return Err(PtyError::WouldBlock);
        }
        self.size = size;
        self.events.push_back(PtyEvent::Resize(size));
        Ok(())
    }

    pub fn next_event(&mut self) -> Option<PtyEvent> {
        self.events.pop_front()
    }

    pub fn master_ready(&self) -> PtyReady {
        let input_available = self
            .limits
            .input_bytes
            .saturating_sub(self.slave_input.len())
            .saturating_sub(self.canonical_input.len());
        let output_available = self
            .limits
            .output_bytes
            .saturating_sub(self.master_output.len());
        PtyReady {
            readable: self.master_open && (!self.master_output.is_empty() || !self.slave_open),
            writable: self.master_open
                && self.slave_open
                && input_available > 0
                && (!self.termios.echo || output_available > 0),
            hangup: !self.slave_open,
            event: false,
        }
    }

    pub fn slave_ready(&self) -> PtyReady {
        PtyReady {
            readable: self.slave_open
                && (!self.slave_input.is_empty()
                    || self.eof_markers.front() == Some(&0)
                    || !self.master_open),
            writable: self.slave_open
                && self.master_open
                && self.master_output.len() < self.limits.output_bytes,
            hangup: !self.master_open,
            event: !self.events.is_empty(),
        }
    }

    pub fn is_fully_closed(&self) -> bool {
        !self.master_open && !self.slave_open
    }

    pub fn master_write(&mut self, bytes: &[u8]) -> PtyResult<usize> {
        self.assert_master_writeable()?;
        if bytes.is_empty() {
            return Ok(0);
        }

        let mut consumed = 0;
        for &byte in bytes {
            match self.process_master_byte(byte) {
                Ok(()) => consumed += 1,
                Err(PtyError::WouldBlock) if consumed > 0 => break,
                Err(error) => return Err(error),
            }
        }
        Ok(consumed)
    }

    pub fn master_read(&mut self, max_bytes: usize) -> PtyResult<PtyRead> {
        if !self.master_open {
            return Err(PtyError::Closed);
        }
        read_queue(&mut self.master_output, max_bytes, !self.slave_open)
    }

    pub fn slave_write(&mut self, bytes: &[u8]) -> PtyResult<usize> {
        if !self.slave_open {
            return Err(PtyError::Closed);
        }
        if !self.master_open {
            return Err(PtyError::BrokenPipe);
        }
        write_queue(&mut self.master_output, self.limits.output_bytes, bytes)
    }

    pub fn slave_read(&mut self, max_bytes: usize) -> PtyResult<PtyRead> {
        if !self.slave_open {
            return Err(PtyError::Closed);
        }
        read_slave_input(
            &mut self.slave_input,
            &mut self.eof_markers,
            max_bytes,
            !self.master_open,
        )
    }

    pub fn close_master(&mut self) {
        if !self.master_open {
            return;
        }
        self.master_open = false;
        self.canonical_input.clear();
    }

    pub fn close_slave(&mut self) {
        if !self.slave_open {
            return;
        }
        self.slave_open = false;
        self.canonical_input.clear();
    }

    fn process_master_byte(&mut self, byte: u8) -> PtyResult<()> {
        let byte = if self.termios.map_cr_to_newline && byte == b'\r' {
            b'\n'
        } else {
            byte
        };

        if self.termios.signals && byte == self.termios.control.interrupt {
            return self.interrupt();
        }
        if !self.termios.canonical {
            return self.accept_raw(byte);
        }
        if byte == self.termios.control.erase {
            return self.erase();
        }
        if byte == self.termios.control.kill {
            return self.kill_line();
        }
        if byte == self.termios.control.eof {
            return self.end_of_file();
        }
        self.accept_canonical(byte)
    }

    fn accept_raw(&mut self, byte: u8) -> PtyResult<()> {
        self.require_capacity(1, usize::from(self.termios.echo))?;
        self.slave_input.push_back(byte);
        if self.termios.echo {
            self.master_output.push_back(byte);
        }
        Ok(())
    }

    fn accept_canonical(&mut self, byte: u8) -> PtyResult<()> {
        let buffered = self
            .slave_input
            .len()
            .saturating_add(self.canonical_input.len());
        if buffered >= self.limits.input_bytes {
            return Err(PtyError::WouldBlock);
        }
        self.require_output_capacity(usize::from(self.termios.echo))?;
        self.canonical_input.push(byte);
        if self.termios.echo {
            self.master_output.push_back(byte);
        }
        if byte == b'\n' {
            self.flush_canonical()?;
        }
        Ok(())
    }

    fn erase(&mut self) -> PtyResult<()> {
        if self.canonical_input.is_empty() {
            return Ok(());
        }
        self.require_output_capacity(if self.termios.echo {
            ERASE_ECHO.len()
        } else {
            0
        })?;
        truncate_last_character(&mut self.canonical_input);
        if self.termios.echo {
            self.master_output.extend(ERASE_ECHO);
        }
        Ok(())
    }

    fn kill_line(&mut self) -> PtyResult<()> {
        let characters = utf8_character_count(&self.canonical_input);
        let echo_bytes = if self.termios.echo {
            characters
                .checked_mul(ERASE_ECHO.len())
                .ok_or(PtyError::WouldBlock)?
        } else {
            0
        };
        self.require_output_capacity(echo_bytes)?;
        self.canonical_input.clear();
        if self.termios.echo {
            for _ in 0..characters {
                self.master_output.extend(ERASE_ECHO);
            }
        }
        Ok(())
    }

    fn end_of_file(&mut self) -> PtyResult<()> {
        if self.canonical_input.is_empty() {
            if self.eof_markers.len() >= self.limits.events {
                return Err(PtyError::WouldBlock);
            }
            self.eof_markers.push_back(self.slave_input.len());
            return Ok(());
        }
        self.flush_canonical()
    }

    fn interrupt(&mut self) -> PtyResult<()> {
        if self.events.len() >= self.limits.events {
            return Err(PtyError::WouldBlock);
        }
        self.require_output_capacity(if self.termios.echo {
            INTERRUPT_ECHO.len()
        } else {
            0
        })?;
        self.canonical_input.clear();
        if self.termios.echo {
            self.master_output.extend(INTERRUPT_ECHO);
        }
        self.events.push_back(PtyEvent::Interrupt);
        Ok(())
    }

    fn flush_canonical(&mut self) -> PtyResult<()> {
        self.slave_input.extend(self.canonical_input.drain(..));
        Ok(())
    }

    fn assert_master_writeable(&self) -> PtyResult<()> {
        if !self.master_open {
            return Err(PtyError::Closed);
        }
        if !self.slave_open {
            return Err(PtyError::BrokenPipe);
        }
        Ok(())
    }

    fn require_capacity(&self, input_bytes: usize, output_bytes: usize) -> PtyResult<()> {
        self.require_input_capacity(input_bytes)?;
        self.require_output_capacity(output_bytes)
    }

    fn require_input_capacity(&self, bytes: usize) -> PtyResult<()> {
        if bytes
            > self
                .limits
                .input_bytes
                .saturating_sub(self.slave_input.len())
        {
            return Err(PtyError::WouldBlock);
        }
        Ok(())
    }

    fn require_output_capacity(&self, bytes: usize) -> PtyResult<()> {
        if bytes
            > self
                .limits
                .output_bytes
                .saturating_sub(self.master_output.len())
        {
            return Err(PtyError::WouldBlock);
        }
        Ok(())
    }
}

fn read_queue(queue: &mut VecDeque<u8>, max_bytes: usize, peer_closed: bool) -> PtyResult<PtyRead> {
    if max_bytes == 0 {
        return Ok(PtyRead::data(Vec::new()));
    }
    let count = max_bytes.min(queue.len());
    if count == 0 {
        return if peer_closed {
            Ok(PtyRead::eof())
        } else {
            Err(PtyError::WouldBlock)
        };
    }
    Ok(PtyRead::data(queue.drain(..count).collect()))
}

fn read_slave_input(
    queue: &mut VecDeque<u8>,
    eof_markers: &mut VecDeque<usize>,
    max_bytes: usize,
    peer_closed: bool,
) -> PtyResult<PtyRead> {
    if max_bytes == 0 {
        return Ok(PtyRead::data(Vec::new()));
    }
    if eof_markers.front() == Some(&0) {
        eof_markers.pop_front();
        return Ok(PtyRead::eof());
    }

    let before_eof = eof_markers.front().copied().unwrap_or(queue.len());
    let count = max_bytes.min(queue.len()).min(before_eof);
    if count == 0 {
        return if peer_closed {
            Ok(PtyRead::eof())
        } else {
            Err(PtyError::WouldBlock)
        };
    }

    for marker in eof_markers {
        *marker -= count;
    }
    Ok(PtyRead::data(queue.drain(..count).collect()))
}

fn write_queue(queue: &mut VecDeque<u8>, capacity: usize, bytes: &[u8]) -> PtyResult<usize> {
    if bytes.is_empty() {
        return Ok(0);
    }
    let available = capacity.saturating_sub(queue.len());
    if available == 0 {
        return Err(PtyError::WouldBlock);
    }
    let written = available.min(bytes.len());
    queue.extend(&bytes[..written]);
    Ok(written)
}

fn truncate_last_character(bytes: &mut Vec<u8>) {
    let Some(mut index) = bytes.len().checked_sub(1) else {
        return;
    };
    while index > 0 && bytes[index] & 0b1100_0000 == 0b1000_0000 {
        index -= 1;
    }
    bytes.truncate(index);
}

fn utf8_character_count(bytes: &[u8]) -> usize {
    bytes
        .iter()
        .filter(|byte| **byte & 0b1100_0000 != 0b1000_0000)
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pty(input_bytes: usize, output_bytes: usize) -> VirtualPty {
        VirtualPty::new(
            PtyLimits::new(input_bytes, output_bytes, 4).unwrap(),
            Termios::default(),
        )
        .unwrap()
    }

    #[test]
    fn canonical_mode_buffers_edits_echoes_and_normalizes_carriage_return() {
        let mut pty = pty(32, 64);

        assert_eq!(pty.master_write("aé".as_bytes()).unwrap(), 3);
        assert_eq!(pty.slave_read(32).unwrap_err(), PtyError::WouldBlock);
        assert_eq!(pty.master_write(&[0x7f]).unwrap(), 1);
        assert_eq!(pty.master_write(b"b\r").unwrap(), 2);

        assert_eq!(pty.slave_read(32).unwrap().bytes, b"ab\n");
        assert_eq!(
            pty.master_read(64).unwrap().bytes,
            "aé\x08 \x08b\n".as_bytes()
        );
    }

    #[test]
    fn raw_mode_delivers_control_bytes_without_line_buffering() {
        let settings = Termios {
            canonical: false,
            echo: false,
            signals: false,
            ..Termios::default()
        };
        let mut pty = VirtualPty::new(PtyLimits::new(8, 8, 2).unwrap(), settings).unwrap();

        assert_eq!(pty.master_write(b"a\x03\x7f").unwrap(), 3);
        assert_eq!(pty.slave_read(8).unwrap().bytes, b"a\x03\x7f");
        assert_eq!(pty.next_event(), None);
        assert_eq!(pty.master_read(8).unwrap_err(), PtyError::WouldBlock);
    }

    #[test]
    fn line_kill_eof_and_interrupt_have_explicit_semantics() {
        let mut pty = pty(32, 64);

        pty.master_write(b"discard\x15kept\x04").unwrap();
        assert_eq!(pty.slave_read(32).unwrap().bytes, b"kept");
        pty.master_write(b"\x04").unwrap();
        assert!(pty.slave_read(32).unwrap().eof);

        pty.master_write(b"partial\x03").unwrap();
        assert_eq!(pty.next_event(), Some(PtyEvent::Interrupt));
        assert_eq!(pty.slave_read(32).unwrap_err(), PtyError::WouldBlock);
        assert!(pty.master_read(64).unwrap().bytes.ends_with(b"partial^C\n"));
    }

    #[test]
    fn eof_markers_preserve_order_with_later_input() {
        let mut pty = pty(16, 16);

        pty.master_write(b"before\n\x04after\n").unwrap();

        assert_eq!(pty.slave_read(16).unwrap().bytes, b"before\n");
        assert!(pty.slave_read(16).unwrap().eof);
        assert_eq!(pty.slave_read(16).unwrap().bytes, b"after\n");
    }

    #[test]
    fn bounded_buffers_return_partial_writes_and_backpressure() {
        let settings = Termios {
            canonical: false,
            echo: false,
            ..Termios::default()
        };
        let mut pty = VirtualPty::new(PtyLimits::new(2, 3, 1).unwrap(), settings).unwrap();

        assert_eq!(pty.master_write(b"abc").unwrap(), 2);
        assert_eq!(pty.master_write(b"c").unwrap_err(), PtyError::WouldBlock);
        assert_eq!(pty.slave_write(b"1234").unwrap(), 3);
        assert_eq!(pty.slave_write(b"4").unwrap_err(), PtyError::WouldBlock);
        assert_eq!(pty.slave_read(2).unwrap().bytes, b"ab");
        assert_eq!(pty.master_read(3).unwrap().bytes, b"123");
    }

    #[test]
    fn canonical_and_ready_input_share_one_memory_limit() {
        let mut pty = pty(4, 16);

        pty.master_write(b"a\n").unwrap();
        assert_eq!(pty.master_write(b"bc").unwrap(), 2);
        assert_eq!(pty.master_write(b"d").unwrap_err(), PtyError::WouldBlock);
        assert_eq!(pty.slave_read(2).unwrap().bytes, b"a\n");
        assert_eq!(pty.master_write(b"d\n").unwrap(), 2);
        assert_eq!(pty.slave_read(4).unwrap().bytes, b"bcd\n");
    }

    #[test]
    fn switching_to_raw_mode_flushes_pending_canonical_input() {
        let mut pty = pty(8, 8);
        pty.master_write(b"abc").unwrap();

        pty.set_termios(Termios {
            canonical: false,
            echo: false,
            ..Termios::default()
        })
        .unwrap();

        assert_eq!(pty.slave_read(8).unwrap().bytes, b"abc");
        pty.master_write(b"d").unwrap();
        assert_eq!(pty.slave_read(8).unwrap().bytes, b"d");
    }

    #[test]
    fn close_and_resize_lifecycle_is_idempotent_and_observable() {
        let mut pty = pty(8, 8);
        let resized = TerminalSize::new(120, 40).unwrap();

        pty.resize(resized).unwrap();
        assert_eq!(pty.terminal_size(), resized);
        assert_eq!(pty.next_event(), Some(PtyEvent::Resize(resized)));

        pty.close_master();
        pty.close_master();
        assert!(pty.slave_read(8).unwrap().eof);
        assert_eq!(pty.slave_write(b"x").unwrap_err(), PtyError::BrokenPipe);
        assert_eq!(pty.master_read(8).unwrap_err(), PtyError::Closed);
    }

    #[test]
    fn closing_slave_drains_output_before_master_eof() {
        let mut pty = pty(8, 8);

        pty.slave_write(b"bye").unwrap();
        pty.close_slave();
        pty.close_slave();

        assert_eq!(pty.master_write(b"x").unwrap_err(), PtyError::BrokenPipe);
        assert_eq!(pty.master_read(8).unwrap().bytes, b"bye");
        assert!(pty.master_read(8).unwrap().eof);
        assert_eq!(pty.slave_read(8).unwrap_err(), PtyError::Closed);
    }

    #[test]
    fn full_event_queue_applies_backpressure_without_partial_interrupt() {
        let mut pty =
            VirtualPty::new(PtyLimits::new(8, 8, 1).unwrap(), Termios::default()).unwrap();
        let size = TerminalSize::new(90, 30).unwrap();
        pty.resize(size).unwrap();

        assert_eq!(pty.master_write(b"\x03").unwrap_err(), PtyError::WouldBlock);
        assert_eq!(pty.master_read(8).unwrap_err(), PtyError::WouldBlock);
        assert_eq!(pty.next_event(), Some(PtyEvent::Resize(size)));

        assert_eq!(pty.master_write(b"\x03").unwrap(), 1);
        assert_eq!(pty.next_event(), Some(PtyEvent::Interrupt));
        assert_eq!(pty.master_read(8).unwrap().bytes, INTERRUPT_ECHO);
    }

    #[test]
    fn separate_ptys_do_not_share_input_output_or_events() {
        let mut first = pty(16, 16);
        let mut second = pty(16, 16);

        first.master_write(b"first\n").unwrap();
        second.master_write(b"second\n").unwrap();
        first.resize(TerminalSize::new(100, 30).unwrap()).unwrap();

        assert_eq!(first.slave_read(16).unwrap().bytes, b"first\n");
        assert_eq!(second.slave_read(16).unwrap().bytes, b"second\n");
        assert_eq!(
            first.next_event(),
            Some(PtyEvent::Resize(TerminalSize::new(100, 30).unwrap()))
        );
        assert_eq!(second.next_event(), None);
        assert_eq!(second.terminal_size(), TerminalSize::default());
    }

    #[test]
    fn rejects_zero_limits_and_terminal_dimensions() {
        assert_eq!(PtyLimits::new(0, 1, 1).unwrap_err(), PtyError::InvalidLimit);
        assert_eq!(
            TerminalSize::new(80, 0).unwrap_err(),
            PtyError::InvalidTerminalSize
        );
    }
}
