/// The virtual terminal settings currently supported by [`super::VirtualPty`].
///
/// This is intentionally a small, portable subset of POSIX termios. Unsupported
/// flags must be added explicitly instead of being silently accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

impl Default for Termios {
    fn default() -> Self {
        Self {
            canonical: true,
            echo: true,
            signals: true,
            map_cr_to_newline: true,
            control: ControlCharacters::default(),
        }
    }
}

/// Control characters recognized by the canonical virtual line discipline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ControlCharacters {
    pub erase: u8,
    pub kill: u8,
    pub eof: u8,
    pub interrupt: u8,
}

impl Default for ControlCharacters {
    fn default() -> Self {
        Self {
            erase: 0x7f,
            kill: 0x15,
            eof: 0x04,
            interrupt: 0x03,
        }
    }
}
