export const EOL = "\n";
export const constants = Object.freeze({
  errno: Object.freeze({
    EACCES: 13,
    EEXIST: 17,
    EINVAL: 22,
    EISDIR: 21,
    ENOENT: 2,
    ENOTDIR: 20,
    EPERM: 1,
    EROFS: 30
  }),
  signals: Object.freeze({
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGILL: 4,
    SIGTRAP: 5,
    SIGABRT: 6,
    SIGBUS: 7,
    SIGFPE: 8,
    SIGKILL: 9,
    SIGUSR1: 10,
    SIGSEGV: 11,
    SIGUSR2: 12,
    SIGPIPE: 13,
    SIGALRM: 14,
    SIGTERM: 15,
    SIGCHLD: 17,
    SIGCONT: 18,
    SIGSTOP: 19,
    SIGTSTP: 20,
    SIGTTIN: 21,
    SIGTTOU: 22
  })
});

export function tmpdir(): string {
  return "/tmp";
}

export function homedir(): string {
  return "/home/webcontainer";
}

export function platform(): NodeJS.Platform {
  return "linux";
}

export function arch(): NodeJS.Architecture {
  return "x64";
}

export function cpus(): Array<{ model: string; speed: number; times: Record<string, number> }> {
  return [{
    model: "browser-native-runtime",
    speed: 0,
    times: { idle: 0, irq: 0, nice: 0, sys: 0, user: 0 }
  }];
}

export function type(): string {
  return "Linux";
}

export function release(): string {
  return "browser";
}

export function version(): string {
  return "browser";
}

export function freemem(): number {
  return 0;
}

export function totalmem(): number {
  return 0;
}

export function networkInterfaces(): Record<string, Array<{
  address: string;
  family: "IPv4" | "IPv6";
  internal: boolean;
  mac: string;
  netmask: string;
  cidr: string | null;
  scopeid?: number;
}>> {
  return {};
}

export const osBuiltin = Object.freeze({
  EOL,
  arch,
  constants,
  cpus,
  default: {
    EOL,
    arch,
    constants,
    cpus,
    freemem,
    homedir,
    networkInterfaces,
    platform,
    release,
    tmpdir,
    totalmem,
    type,
    version
  },
  freemem,
  homedir,
  networkInterfaces,
  platform,
  release,
  tmpdir,
  totalmem,
  type,
  version
});
