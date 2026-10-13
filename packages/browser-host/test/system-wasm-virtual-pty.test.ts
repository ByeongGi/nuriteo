import assert from "node:assert/strict";
import fs from "node:fs";

import { SystemWasmClient } from "../src/process/system-wasm-client.ts";
import { SystemWasmVirtualPty } from "../src/process/virtual-pty.ts";

const wasm = fs.readFileSync("target/wasm32-unknown-unknown/debug/system_wasm.wasm");
const client = await SystemWasmClient.load("https://runtime.test/system_wasm.wasm", async () => new Response(wasm));
const first = new SystemWasmVirtualPty(client, { canonical: true, echo: true, signals: true }, { cols: 80, rows: 24 });

assert.deepEqual(first.write("abc"), { echo: "abc", eof: false, input: "", interrupt: false });
assert.deepEqual(first.write("\x7fZ\r"), { echo: "\b \bZ\n", eof: false, input: "abZ\n", interrupt: false });
assert.equal(first.writeOutput("guest output\n").output, "guest output\n");
assert.equal(first.write("\x03").interrupt, true);
first.resize({ cols: 120, rows: 40 });
first.close(130);

const second = new SystemWasmVirtualPty(client, { canonical: false, echo: false, signals: true }, { cols: 100, rows: 30 });
const pressure = "x".repeat(16 * 1024);
assert.deepEqual(second.write(pressure), { echo: "", eof: false, input: pressure, interrupt: false });
assert.equal(second.writeOutput(pressure).output, pressure);
second.close();

console.log("system WASM virtual PTY integration test ok");
