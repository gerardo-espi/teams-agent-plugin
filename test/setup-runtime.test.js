import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkLocalPorts, hostTunnel, runBridge, tunnelEndpoint } from "../src/setup-runtime.js";

async function availablePort(t) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { if (server.listening) server.close(); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return String(port);
}

test("tunnel URL detection selects the bot HTTPS URL, not inspection or explicit-port URLs", () => {
  const output = "Hosting port 3978 at https://abc.usw2.devtunnels.ms:3978/, "
    + "https://abc-3978.usw2.devtunnels.ms/ and inspect it at https://abc-3978-inspect.usw2.devtunnels.ms/\n";
  assert.equal(tunnelEndpoint(output, "3978"), "https://abc-3978.usw2.devtunnels.ms/api/messages");
  assert.equal(tunnelEndpoint(output, "3979"), undefined);
  assert.equal(tunnelEndpoint("Hosting port 3978 at https://abc-3978.evil.test/", "3978"), undefined);
});

test("host waits for readiness, handles chunked output, and stops its exact child", async (t) => {
  const host = await hostTunnel({
    command: process.execPath, port: "3978",
    args: ["-e", `
      process.stdout.write("Hosting port 3978 at https://");
      setTimeout(() => console.log("abc-3978.usw2.devtunnels.ms/\\nReady to accept connections for tunnel: abc"), 20);
      setInterval(() => {}, 1000);
    `],
  });
  t.after(() => host.stop());
  assert.equal(host.endpoint, "https://abc-3978.usw2.devtunnels.ms/api/messages");
  assert.equal(host.stopped, false);
  await host.stop();
  assert.equal(host.stopped, true);
});

test("host fails on early exit, timeout and cancellation without leaving a running child", async () => {
  await assert.rejects(hostTunnel({
    command: process.execPath, args: ["-e", "process.exit(1)"], port: "3978",
  }), /stopped before/);
  await assert.rejects(hostTunnel({
    command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], port: "3978", timeout: 50,
  }), /Timed out/);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("cancel setup")), 50);
  await assert.rejects(hostTunnel({
    command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], port: "3978", signal: controller.signal,
  }), /cancel setup/);
});

test("setup refuses to expose a port already occupied by another local service", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(checkLocalPorts([server.address().port]), /unavailable/);
});

test("bridge readiness includes a health check, and cancellation requests graceful shutdown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "teams-agent-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "stopped");
  const port = await availablePort(t);
  const controller = new AbortController();
  const logs = [];
  await runBridge({
    root, env: { PORT: port }, signal: controller.signal,
    args: ["-e", `
      const server = require("http").createServer((req, res) => {
        res.setHeader("Content-Type", "application/json"); res.end('{"ok":true}');
      });
      server.listen(Number(process.env.PORT), "127.0.0.1", () => process.send({type:"ready"}));
      process.on("message", () => server.close(() => {
        require("fs").writeFileSync(${JSON.stringify(marker)}, "graceful"); process.disconnect();
      }));
    `],
    log: (message) => { logs.push(message); controller.abort(); },
  });
  assert.ok(logs.some((message) => message.includes("running")));
  assert.equal(await readFile(marker, "utf8"), "graceful");
});

test("bridge startup and tunnel failures stop the paired bot process", async (t) => {
  await assert.rejects(runBridge({
    root: tmpdir(), env: {}, args: ["-e", "process.exit(2)"],
  }), /stopped unexpectedly/);
  await assert.rejects(runBridge({
    root: tmpdir(), env: {}, args: ["-e", "setInterval(() => {}, 1000)"], timeout: 50,
  }), /Timed out/);
  await assert.rejects(runBridge({
    root: tmpdir(), env: { PORT: await availablePort(t) },
    args: ["-e", "setInterval(() => {}, 1000)"],
    tunnel: { exited: Promise.resolve({ code: 1 }) },
  }), /dev tunnel stopped/);
});
