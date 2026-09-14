export function createGuestCli(registry) {
  return {
    run(argv) {
      const [name, ...args] = argv;
      const entry = registry.resolve(name);
      if (args.length === 1 && args[0] === "--version") {
        return {
          stdout: `${entry.version}\n`,
          stderr: "",
          exitCode: 0,
          entry: entry.entry,
          entrySha256: entry.entrySha256
        };
      }
      return {
        stdout: "",
        stderr: `${name}: unsupported CLI arguments: ${args.join(" ")}\n`,
        exitCode: 1,
        entry: entry.entry,
        entrySha256: entry.entrySha256
      };
    }
  };
}
