export const EOL = "\n";

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

export function freemem(): number {
  return 0;
}

export function totalmem(): number {
  return 0;
}

export const osBuiltin = Object.freeze({
  EOL,
  arch,
  cpus,
  default: {
    EOL,
    arch,
    cpus,
    freemem,
    homedir,
    platform,
    release,
    tmpdir,
    totalmem,
    type
  },
  freemem,
  homedir,
  platform,
  release,
  tmpdir,
  totalmem,
  type
});
