/// The virtual terminal settings currently supported by [`super::VirtualPty`].
///
/// This is intentionally a small, portable subset of POSIX termios. Unsupported
/// flags must be added explicitly instead of being silently accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Termios {
    /// Buffer terminal input until a line delimiter or EOF control character.
    pub canonical: bool,
    /// Echo accepted terminal input back to the PTY master.
    pub echo: bool,
    /// Interpret the configured interrupt control character as a virtual signal.
    pub signals: bool,
    /// Translate carriage return input to newline before processing it.
    pub map_cr_to_newline: bool,
    /// Configurable control characters for the virtual line discipline.
    pub control: ControlCharacters,
}

impl Termios {
    /// Canonical settings with echo, signals, and carriage return mapped to newline.
    #[must_use]
    pub fn new() -> Self {
        Self {
            canonical: true,
            echo: true,
            signals: true,
            map_cr_to_newline: true,
            control: ControlCharacters::new(),
        }
    }
}

impl Default for Termios {
    fn default() -> Self {
        Self::new()
    }
}

/// Control characters recognized by the canonical virtual line discipline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ControlCharacters {
    /// Character that deletes the previous input byte.
    pub erase: u8,
    /// Character that discards the current canonical line.
    pub kill: u8,
    /// Character that marks end of file on an empty line.
    pub eof: u8,
    /// Character that records an interrupt event.
    pub interrupt: u8,
}

impl ControlCharacters {
    /// DEL, Ctrl-U, Ctrl-D, and Ctrl-C.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            erase: 0x7f,
            kill: 0x15,
            eof: 0x04,
            interrupt: 0x03,
        }
    }
}

impl Default for ControlCharacters {
    fn default() -> Self {
        Self::new()
    }
}
