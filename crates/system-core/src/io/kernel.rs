use std::{
    collections::BTreeMap,
    error::Error,
    fmt::{self, Display, Formatter},
};

use crate::{
    fs::{Fd, FsError, OpenOptions, Pid, SystemFs},
    io::{PtyError, PtyEvent, PtyLimits, TerminalSize, Termios, VirtualPty},
    process::{
        ProcessError, ProcessGroupId, ProcessTable, SessionId, SignalDelivery, VirtualSignal,
    },
};

/// Identifier of one virtual terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PtyId(pub u32);

/// Master and slave descriptors of a new PTY.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PtyPair {
    /// Identifier used for later terminal control.
    pub id: PtyId,
    /// Descriptor installed in the master process.
    pub master_fd: Fd,
    /// Descriptor installed in the slave process.
    pub slave_fd: Fd,
}

/// Bytes read from a descriptor, plus an EOF flag.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct IoRead {
    /// Bytes copied out of the file or PTY.
    pub bytes: Vec<u8>,
    /// No further bytes will arrive on this descriptor.
    pub eof: bool,
}

/// Readiness bits for one file descriptor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PollState {
    /// A read would return bytes or EOF.
    pub readable: bool,
    /// A write would accept bytes.
    pub writable: bool,
    /// The peer side of a PTY is closed.
    pub hangup: bool,
    /// A PTY interrupt or resize is waiting.
    pub priority: bool,
}

/// Session and foreground group attached to a PTY.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TerminalControl {
    /// Session that owns the controlling terminal.
    pub session: SessionId,
    /// Group that receives interrupt and resize signals.
    pub foreground_process_group: ProcessGroupId,
}

/// Terminal control operation applied to a descriptor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IoctlRequest {
    /// Read the current terminal settings.
    GetTermios,
    /// Replace the terminal settings.
    SetTermios(Termios),
    /// Read the current character dimensions.
    GetTerminalSize,
    /// Replace the character dimensions.
    SetTerminalSize(TerminalSize),
}

/// Result of a terminal control operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IoctlResponse {
    /// The request changed state and has no payload.
    None,
    /// Current terminal settings.
    Termios(Termios),
    /// Current character dimensions.
    TerminalSize(TerminalSize),
}

/// Descriptor, filesystem, process, or PTY failure.
#[must_use]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IoError {
    /// No free descriptor number remains for the process.
    DescriptorExhausted,
    /// A filesystem operation failed.
    Fs(FsError),
    /// The descriptor is not open for this process.
    InvalidFd,
    /// The PTY has no controlling session.
    NoControllingTerminal,
    /// The descriptor is not a terminal.
    NotTerminal,
    /// A process-table operation failed.
    Process(ProcessError),
    /// A virtual-terminal operation failed.
    Pty(PtyError),
    /// No free PTY identifier remains.
    PtyExhausted,
}

impl Display for IoError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::DescriptorExhausted => formatter.write_str("file descriptor space exhausted"),
            Self::Fs(error) => write!(formatter, "filesystem error: {error}"),
            Self::InvalidFd => formatter.write_str("invalid file descriptor"),
            Self::NoControllingTerminal => formatter.write_str("PTY has no controlling session"),
            Self::NotTerminal => formatter.write_str("file descriptor is not a terminal"),
            Self::Process(error) => write!(formatter, "process error: {error}"),
            Self::Pty(error) => write!(formatter, "PTY error: {error}"),
            Self::PtyExhausted => formatter.write_str("PTY identifier space exhausted"),
        }
    }
}

impl IoError {
    /// Guest-visible sentence for this failure.
    ///
    /// Wrapped filesystem, process, and PTY errors contribute their own sentence.
    #[must_use]
    pub const fn reason(&self) -> &'static str {
        match self {
            Self::DescriptorExhausted => "file descriptor space exhausted",
            Self::Fs(error) => error.reason(),
            Self::InvalidFd => "invalid file descriptor",
            Self::NoControllingTerminal => "PTY has no controlling session",
            Self::NotTerminal => "file descriptor is not a terminal",
            Self::Process(error) => error.reason(),
            Self::Pty(error) => error.reason(),
            Self::PtyExhausted => "PTY identifier space exhausted",
        }
    }
}

impl Error for IoError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Fs(error) => Some(error),
            Self::Process(error) => Some(error),
            Self::Pty(error) => Some(error),
            Self::DescriptorExhausted
            | Self::InvalidFd
            | Self::NoControllingTerminal
            | Self::NotTerminal
            | Self::PtyExhausted => None,
        }
    }
}

impl From<FsError> for IoError {
    fn from(error: FsError) -> Self {
        Self::Fs(error)
    }
}

impl From<PtyError> for IoError {
    fn from(error: PtyError) -> Self {
        Self::Pty(error)
    }
}

impl From<ProcessError> for IoError {
    fn from(error: ProcessError) -> Self {
        Self::Process(error)
    }
}

/// Descriptor I/O result alias.
pub type IoResult<T> = Result<T, IoError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum PtySide {
    Master,
    Slave,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Descriptor {
    File {
        fd: Fd,
        readable: bool,
        writable: bool,
    },
    Pty {
        id: PtyId,
        side: PtySide,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct DescriptorTable {
    next_fd: u32,
    entries: BTreeMap<Fd, Descriptor>,
}

impl Default for DescriptorTable {
    fn default() -> Self {
        Self::new()
    }
}

impl DescriptorTable {
    fn new() -> Self {
        Self {
            next_fd: Fd::FIRST_ISSUED,
            entries: BTreeMap::new(),
        }
    }

    fn insert(&mut self, descriptor: Descriptor) -> IoResult<Fd> {
        let fd = Fd(self.next_fd);
        self.next_fd = self
            .next_fd
            .checked_add(1)
            .ok_or(IoError::DescriptorExhausted)?;
        self.entries.insert(fd, descriptor);
        Ok(fd)
    }

    fn get(&self, fd: Fd) -> IoResult<Descriptor> {
        self.entries.get(&fd).copied().ok_or(IoError::InvalidFd)
    }

    fn remove(&mut self, fd: Fd) -> IoResult<Descriptor> {
        self.entries.remove(&fd).ok_or(IoError::InvalidFd)
    }
}

/// Per-process descriptors over the shared filesystem and PTYs.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct KernelIo {
    fs: SystemFs,
    descriptors: BTreeMap<Pid, DescriptorTable>,
    ptys: BTreeMap<PtyId, VirtualPty>,
    terminal_controls: BTreeMap<PtyId, TerminalControl>,
    next_pty: u32,
}

impl Default for KernelIo {
    fn default() -> Self {
        Self {
            fs: SystemFs::new(),
            descriptors: BTreeMap::new(),
            ptys: BTreeMap::new(),
            terminal_controls: BTreeMap::new(),
            next_pty: 1,
        }
    }
}

impl KernelIo {
    /// Creates an empty instance with its default root state.
    ///
    /// # Panics
    /// Panics if the embedded filesystem cannot create `/workspace`.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Borrows the shared filesystem.
    #[must_use]
    pub fn filesystem(&self) -> &SystemFs {
        &self.fs
    }

    /// Borrows the shared filesystem for modification.
    #[must_use]
    pub fn filesystem_mut(&mut self) -> &mut SystemFs {
        &mut self.fs
    }

    /// Opens a path and installs a descriptor for `pid`.
    ///
    /// # Errors
    /// Returns [`IoError::Fs`] for a filesystem open failure and
    /// [`IoError::DescriptorExhausted`] when either descriptor table has no free number.
    pub fn open_file(&mut self, pid: Pid, path: &str, options: OpenOptions) -> IoResult<Fd> {
        let internal_fd = match self.fs.open(pid, path, options) {
            Ok(fd) => fd,
            Err(FsError::DescriptorExhausted) => return Err(IoError::DescriptorExhausted),
            Err(error) => return Err(error.into()),
        };
        match self.descriptor_table(pid).insert(Descriptor::File {
            fd: internal_fd,
            readable: options.read,
            writable: options.write,
        }) {
            Ok(fd) => Ok(fd),
            Err(error) => {
                let _ = self.fs.close(pid, internal_fd);
                Err(error)
            }
        }
    }

    /// Allocates a PTY and returns its master and slave descriptors.
    ///
    /// # Errors
    /// Returns [`IoError::PtyExhausted`] when the PTY id space is full,
    /// [`IoError::Pty`] when the limits are zero, and
    /// [`IoError::DescriptorExhausted`] when either process has no free descriptor.
    pub fn open_pty(
        &mut self,
        master_pid: Pid,
        slave_pid: Pid,
        limits: PtyLimits,
        termios: Termios,
    ) -> IoResult<PtyPair> {
        let id = PtyId(self.next_pty);
        let next_pty = self.next_pty.checked_add(1).ok_or(IoError::PtyExhausted)?;
        let pty = VirtualPty::new(limits, termios)?;

        let master_fd = self.descriptor_table(master_pid).insert(Descriptor::Pty {
            id,
            side: PtySide::Master,
        })?;
        let slave_fd = match self.descriptor_table(slave_pid).insert(Descriptor::Pty {
            id,
            side: PtySide::Slave,
        }) {
            Ok(fd) => fd,
            Err(error) => {
                let _ = self.descriptor_table(master_pid).remove(master_fd);
                return Err(error);
            }
        };

        self.next_pty = next_pty;
        self.ptys.insert(id, pty);
        Ok(PtyPair {
            id,
            master_fd,
            slave_fd,
        })
    }

    /// Reads up to `max_bytes` from a file or PTY descriptor.
    ///
    /// # Errors
    /// Returns [`IoError::InvalidFd`] when `pid` has no such descriptor,
    /// [`IoError::Fs`] when a file read is not allowed, and [`IoError::Pty`]
    /// when the PTY side is closed.
    pub fn read(&mut self, pid: Pid, fd: Fd, max_bytes: usize) -> IoResult<IoRead> {
        match self.descriptor(pid, fd)? {
            Descriptor::File { fd, readable, .. } => {
                if !readable {
                    return Err(IoError::Fs(FsError::PermissionDenied));
                }
                let bytes = self.fs.read(pid, fd, max_bytes)?;
                let eof = max_bytes > 0 && bytes.is_empty();
                Ok(IoRead { bytes, eof })
            }
            Descriptor::Pty { id, side } => {
                let pty = self.pty_mut(id)?;
                let read = match side {
                    PtySide::Master => pty.master_read(max_bytes),
                    PtySide::Slave => pty.slave_read(max_bytes),
                }?;
                Ok(IoRead {
                    bytes: read.bytes,
                    eof: read.eof,
                })
            }
        }
    }

    /// Writes bytes to a file or PTY descriptor.
    ///
    /// # Errors
    /// Returns [`IoError::InvalidFd`] when `pid` has no such descriptor,
    /// [`IoError::Fs`] when a file write is not allowed, and [`IoError::Pty`]
    /// when the PTY cannot accept the write.
    pub fn write(&mut self, pid: Pid, fd: Fd, bytes: &[u8]) -> IoResult<usize> {
        match self.descriptor(pid, fd)? {
            Descriptor::File { fd, writable, .. } => {
                if !writable {
                    return Err(IoError::Fs(FsError::PermissionDenied));
                }
                Ok(self.fs.write(pid, fd, bytes)?)
            }
            Descriptor::Pty { id, side } => {
                let pty = self.pty_mut(id)?;
                Ok(match side {
                    PtySide::Master => pty.master_write(bytes),
                    PtySide::Slave => pty.slave_write(bytes),
                }?)
            }
        }
    }

    /// Applies a terminal control request to a descriptor.
    ///
    /// # Errors
    /// Returns [`IoError::InvalidFd`] when the descriptor is missing,
    /// [`IoError::NotTerminal`] when it is a regular file, and [`IoError::Pty`]
    /// when the PTY rejects the new settings or size.
    pub fn ioctl(&mut self, pid: Pid, fd: Fd, request: IoctlRequest) -> IoResult<IoctlResponse> {
        let Descriptor::Pty { id, .. } = self.descriptor(pid, fd)? else {
            return Err(IoError::NotTerminal);
        };
        let pty = self.pty_mut(id)?;
        match request {
            IoctlRequest::GetTermios => Ok(IoctlResponse::Termios(pty.termios())),
            IoctlRequest::SetTermios(termios) => {
                pty.set_termios(termios)?;
                Ok(IoctlResponse::None)
            }
            IoctlRequest::GetTerminalSize => Ok(IoctlResponse::TerminalSize(pty.terminal_size())),
            IoctlRequest::SetTerminalSize(size) => {
                pty.resize(size)?;
                Ok(IoctlResponse::None)
            }
        }
    }

    /// Returns readiness for a descriptor.
    ///
    /// # Errors
    /// Returns [`IoError::InvalidFd`] when `pid` has no such descriptor.
    pub fn poll(&self, pid: Pid, fd: Fd) -> IoResult<PollState> {
        match self.descriptor(pid, fd)? {
            Descriptor::File {
                readable, writable, ..
            } => Ok(PollState {
                readable,
                writable,
                hangup: false,
                priority: false,
            }),
            Descriptor::Pty { id, side } => {
                let pty = self.ptys.get(&id).ok_or(IoError::InvalidFd)?;
                let ready = match side {
                    PtySide::Master => pty.master_ready(),
                    PtySide::Slave => pty.slave_ready(),
                };
                Ok(PollState {
                    readable: ready.readable,
                    writable: ready.writable,
                    hangup: ready.hangup,
                    priority: ready.event,
                })
            }
        }
    }

    /// Pops the next recorded terminal event.
    ///
    /// # Errors
    /// Returns [`IoError::InvalidFd`] when `id` is not an open PTY.
    pub fn next_pty_event(&mut self, id: PtyId) -> IoResult<Option<PtyEvent>> {
        Ok(self.pty_mut(id)?.next_event())
    }

    /// Attaches a PTY as the controlling terminal of `pid`.
    ///
    /// # Errors
    /// Returns [`IoError::InvalidFd`] when the PTY is missing,
    /// [`IoError::Process`] when it already has a session or `pid` is unknown.
    pub fn attach_controlling_terminal(
        &mut self,
        processes: &ProcessTable,
        pid: Pid,
        id: PtyId,
    ) -> IoResult<TerminalControl> {
        if !self.ptys.contains_key(&id) {
            return Err(IoError::InvalidFd);
        }
        if self.terminal_controls.contains_key(&id) {
            return Err(IoError::Process(ProcessError::InvalidSession));
        }
        let process = processes.get(pid)?;
        let control = TerminalControl {
            session: process.session,
            foreground_process_group: process.process_group,
        };
        self.terminal_controls.insert(id, control);
        Ok(control)
    }

    /// Returns the session and foreground group of a PTY.
    ///
    /// # Errors
    /// Returns [`IoError::NoControllingTerminal`] when `id` has not been attached.
    pub fn terminal_control(&self, id: PtyId) -> IoResult<TerminalControl> {
        self.terminal_controls
            .get(&id)
            .copied()
            .ok_or(IoError::NoControllingTerminal)
    }

    /// Sets the foreground process group of a controlling terminal.
    ///
    /// # Errors
    /// Returns [`IoError::NoControllingTerminal`] when the PTY is not attached
    /// and [`IoError::Process`] when `pid` or the group is outside that session.
    pub fn set_foreground_process_group(
        &mut self,
        processes: &ProcessTable,
        pid: Pid,
        id: PtyId,
        process_group: ProcessGroupId,
    ) -> IoResult<TerminalControl> {
        let control = self.terminal_control(id)?;
        let process = processes.get(pid)?;
        if process.session != control.session || !processes.same_session(pid, process_group)? {
            return Err(IoError::Process(ProcessError::InvalidProcessGroup));
        }
        let control = TerminalControl {
            foreground_process_group: process_group,
            ..control
        };
        self.terminal_controls.insert(id, control);
        Ok(control)
    }

    /// Turns a pending terminal event into process signals.
    ///
    /// # Errors
    /// Returns [`IoError::InvalidFd`] when the PTY is missing,
    /// [`IoError::NoControllingTerminal`] when it has no session, and
    /// [`IoError::Process`] when the foreground group cannot take the signal.
    pub fn dispatch_terminal_event(
        &mut self,
        processes: &mut ProcessTable,
        id: PtyId,
    ) -> IoResult<Vec<SignalDelivery>> {
        let Some(event) = self.next_pty_event(id)? else {
            return Ok(Vec::new());
        };
        let control = self.terminal_control(id)?;
        let signal = match event {
            PtyEvent::Interrupt => VirtualSignal::Interrupt,
            PtyEvent::Resize(_) => VirtualSignal::WindowChanged,
        };
        Ok(processes.signal_process_group(control.foreground_process_group, signal)?)
    }

    /// Closes one descriptor owned by `pid`.
    ///
    /// # Errors
    /// Returns [`IoError::InvalidFd`] when `pid` has no such descriptor, and
    /// [`IoError::Fs`] or [`IoError::Pty`] when the underlying close fails.
    pub fn close(&mut self, pid: Pid, fd: Fd) -> IoResult<()> {
        let descriptor = self
            .descriptors
            .get_mut(&pid)
            .ok_or(IoError::InvalidFd)?
            .remove(fd)?;
        match descriptor {
            Descriptor::File { fd, .. } => self.fs.close(pid, fd)?,
            Descriptor::Pty { id, side } => {
                let fully_closed = {
                    let pty = self.pty_mut(id)?;
                    match side {
                        PtySide::Master => pty.close_master(),
                        PtySide::Slave => pty.close_slave(),
                    }
                    pty.is_fully_closed()
                };
                if fully_closed {
                    self.ptys.remove(&id);
                    self.terminal_controls.remove(&id);
                }
            }
        }
        if self
            .descriptors
            .get(&pid)
            .is_some_and(|table| table.entries.is_empty())
        {
            self.descriptors.remove(&pid);
        }
        Ok(())
    }

    /// Closes every descriptor owned by `pid`.
    ///
    /// # Errors
    /// Returns the same errors as [`Self::close`] for the first descriptor that fails.
    /// A process with no descriptors succeeds.
    pub fn close_process(&mut self, pid: Pid) -> IoResult<()> {
        let Some(table) = self.descriptors.get(&pid) else {
            return Ok(());
        };
        let fds: Vec<Fd> = table.entries.keys().copied().collect();
        for fd in fds {
            self.close(pid, fd)?;
        }
        Ok(())
    }

    fn descriptor_table(&mut self, pid: Pid) -> &mut DescriptorTable {
        self.descriptors.entry(pid).or_default()
    }

    fn descriptor(&self, pid: Pid, fd: Fd) -> IoResult<Descriptor> {
        self.descriptors
            .get(&pid)
            .ok_or(IoError::InvalidFd)?
            .get(fd)
    }

    fn pty_mut(&mut self, id: PtyId) -> IoResult<&mut VirtualPty> {
        self.ptys.get_mut(&id).ok_or(IoError::InvalidFd)
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, error::Error};

    use super::*;

    const HOST: Pid = Pid(1);
    const GUEST: Pid = Pid(2);
    const OUTSIDER: Pid = Pid(3);

    #[test]
    fn reports_filesystem_descriptor_exhaustion_as_kernel_exhaustion() {
        let mut io = KernelIo::new();
        io.open_file(
            HOST,
            "/workspace/file.txt",
            OpenOptions::read_write_create(),
        )
        .unwrap();
        io.filesystem_mut().saturate_descriptors(HOST);

        let error = io
            .open_file(HOST, "/workspace/file.txt", OpenOptions::read_only())
            .unwrap_err();

        assert_eq!(error, IoError::DescriptorExhausted);
        assert_eq!(error.reason(), "file descriptor space exhausted");
    }

    #[test]
    fn nested_io_errors_keep_their_source() {
        let error = IoError::Fs(FsError::NotFound);
        assert_eq!(error.to_string(), "filesystem error: path was not found");
        assert_eq!(
            error.source().map(ToString::to_string).as_deref(),
            Some("path was not found")
        );
    }

    #[test]
    fn files_and_ptys_share_each_process_descriptor_namespace() {
        let mut io = KernelIo::new();
        let file = io
            .open_file(
                HOST,
                "/workspace/file.txt",
                OpenOptions::read_write_create(),
            )
            .unwrap();
        let pair = io
            .open_pty(HOST, HOST, PtyLimits::default(), Termios::default())
            .unwrap();

        assert_eq!(file, Fd(3));
        assert_eq!(pair.master_fd, Fd(4));
        assert_eq!(pair.slave_fd, Fd(5));
    }

    #[test]
    fn routes_line_disciplined_io_ioctl_poll_and_events() {
        let mut io = KernelIo::new();
        let pair = io
            .open_pty(HOST, GUEST, PtyLimits::default(), Termios::default())
            .unwrap();

        assert_eq!(io.write(HOST, pair.master_fd, b"hello\r").unwrap(), 6);
        assert_eq!(io.read(GUEST, pair.slave_fd, 32).unwrap().bytes, b"hello\n");
        assert_eq!(io.read(HOST, pair.master_fd, 32).unwrap().bytes, b"hello\n");

        let size = TerminalSize::new(120, 40).unwrap();
        assert_eq!(
            io.ioctl(HOST, pair.master_fd, IoctlRequest::SetTerminalSize(size))
                .unwrap(),
            IoctlResponse::None
        );
        assert_eq!(
            io.ioctl(GUEST, pair.slave_fd, IoctlRequest::GetTerminalSize)
                .unwrap(),
            IoctlResponse::TerminalSize(size)
        );
        assert!(io.poll(GUEST, pair.slave_fd).unwrap().priority);
        assert_eq!(
            io.next_pty_event(pair.id).unwrap(),
            Some(PtyEvent::Resize(size))
        );
    }

    #[test]
    fn keeps_descriptor_ownership_process_scoped() {
        let mut io = KernelIo::new();
        let pair = io
            .open_pty(HOST, GUEST, PtyLimits::default(), Termios::default())
            .unwrap();

        // Descriptor numbers are local to a process, so both endpoints may be
        // fd 3 while still resolving to different sides of the PTY.
        assert_eq!(pair.master_fd, pair.slave_fd);
        io.write(GUEST, pair.slave_fd, b"output").unwrap();
        assert_eq!(io.read(HOST, pair.master_fd, 32).unwrap().bytes, b"output");

        assert_eq!(
            io.read(OUTSIDER, pair.master_fd, 1).unwrap_err(),
            IoError::InvalidFd
        );
        assert_eq!(
            io.write(OUTSIDER, pair.slave_fd, b"x").unwrap_err(),
            IoError::InvalidFd
        );
    }

    #[test]
    fn process_teardown_closes_pty_sides_and_releases_state() {
        let mut io = KernelIo::new();
        let pair = io
            .open_pty(HOST, GUEST, PtyLimits::default(), Termios::default())
            .unwrap();

        io.close_process(GUEST).unwrap();
        let state = io.poll(HOST, pair.master_fd).unwrap();
        assert!(state.readable);
        assert!(state.hangup);
        assert!(io.read(HOST, pair.master_fd, 1).unwrap().eof);

        io.close_process(HOST).unwrap();
        assert_eq!(io.next_pty_event(pair.id).unwrap_err(), IoError::InvalidFd);
        io.close_process(HOST).unwrap();
    }

    #[test]
    fn rejects_terminal_ioctl_for_regular_files() {
        let mut io = KernelIo::new();
        let file = io
            .open_file(HOST, "/workspace/file.txt", OpenOptions::read_only())
            .unwrap_err();
        assert_eq!(file, IoError::Fs(FsError::NotFound));

        let file = io
            .open_file(
                HOST,
                "/workspace/file.txt",
                OpenOptions::read_write_create(),
            )
            .unwrap();
        assert_eq!(
            io.ioctl(HOST, file, IoctlRequest::GetTermios).unwrap_err(),
            IoError::NotTerminal
        );
    }

    #[test]
    fn routes_terminal_events_to_the_foreground_process_group() {
        let mut processes = ProcessTable::default();
        let shell = processes
            .prepare(None, "/workspace", BTreeMap::new())
            .unwrap();
        let command = processes
            .prepare(Some(shell.pid), "/workspace", BTreeMap::new())
            .unwrap();
        let command = processes
            .set_process_group(command.pid, ProcessGroupId(command.pid.0))
            .unwrap();
        let mut io = KernelIo::new();
        let pair = io
            .open_pty(HOST, shell.pid, PtyLimits::default(), Termios::default())
            .unwrap();

        let control = io
            .attach_controlling_terminal(&processes, shell.pid, pair.id)
            .unwrap();
        assert_eq!(control.foreground_process_group, shell.process_group);
        io.set_foreground_process_group(&processes, shell.pid, pair.id, command.process_group)
            .unwrap();

        io.write(HOST, pair.master_fd, b"\x03").unwrap();
        let deliveries = io.dispatch_terminal_event(&mut processes, pair.id).unwrap();
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].pid, command.pid);
        assert_eq!(deliveries[0].signal, VirtualSignal::Interrupt);
        assert_eq!(
            processes.take_signal(command.pid).unwrap(),
            Some(VirtualSignal::Interrupt)
        );
        assert_eq!(processes.take_signal(shell.pid).unwrap(), None);

        io.ioctl(
            HOST,
            pair.master_fd,
            IoctlRequest::SetTerminalSize(TerminalSize::new(100, 30).unwrap()),
        )
        .unwrap();
        assert_eq!(
            io.dispatch_terminal_event(&mut processes, pair.id).unwrap()[0].signal,
            VirtualSignal::WindowChanged
        );
    }
}
