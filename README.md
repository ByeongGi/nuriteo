# NURITEO

NURITEO is an open-source browser-native development environment. Open a GitHub project or template in the browser, install it, edit it, run it, and follow the result through Preview.

This repository is the self-hosted product. Managed cloud is out of scope. On desktop Chrome, a Vite project can be opened, edited, and previewed. Arbitrary npm packages, mobile Safari, Docker-in-the-browser, and native addons are outside the supported set.

한국어 안내: [README.ko.md](./README.ko.md).

## Develop

Requirements:

- Node.js 24.17 or newer, below 25
- pnpm 11.15 or newer, below 12
- Rust toolchain 1.97

```bash
pnpm install
pnpm dev
```

`pnpm dev` keeps PostgreSQL and RustFS in containers, rebuilds and restarts Core when Rust sources change, and refreshes Web through Next.js HMR. The app is at `http://127.0.0.1:3000`. Data containers stay after shutdown so the next start is faster. Stop them with `pnpm dev:stack:down`.

To restart Backend and Web separately, use two terminals. The first prepares PostgreSQL, RustFS, and Core. The second can stop and start Web on its own.

```bash
# Terminal 1: database, object storage, and Core
pnpm dev:backend

# Terminal 2: Next.js Web
pnpm dev:web
```

`pnpm dev:fe` is the same Web-only command as `pnpm dev:web`.

To exercise PostgreSQL, RustFS, Core, and Web with the same boundary as the production images:

```bash
pnpm dev:stack
```

The first run writes development credentials and TLS under `.local/nuriteo-compose`. Read them with `pnpm dev:stack:credentials` and check status with `pnpm dev:stack:status`. `pnpm dev:stack:down` keeps data. `pnpm dev:stack:reset` deletes data and credentials.

Checks:

```bash
pnpm check:workspace
pnpm check:types
pnpm test:web
pnpm test:workspace-runtime
cargo test --workspace
```

## License

NURITEO is released under the [Apache License 2.0](./LICENSE).
