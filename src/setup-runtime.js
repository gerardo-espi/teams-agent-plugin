import spawn from "cross-spawn";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function launch(command, args, options = {}) {
  const child = spawn(command, args, options);
  let result;
  const exited = new Promise((resolve) => {
    child.once("error", () => { result = { error: true }; resolve(result); });
    child.once("exit", (code, signal) => { result = { code, signal }; resolve(result); });
  });
  return {
    child, exited,
    get stopped() { return Boolean(result); },
    async stop() {
      if (result) return;
      if (child.connected) child.send({ type: "shutdown" }, () => {});
      else child.kill();
      const timer = delay(5000, false, { ref: false });
      if (!await Promise.race([exited.then(() => true), timer])) child.kill();
      await exited;
    },
  };
}

export async function checkLocalPorts(ports) {
  for (const port of ports) {
    const server = createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(Number(port), "127.0.0.1", resolve);
      });
    } catch {
      throw new Error(`Local port ${port} is unavailable. Stop the old bridge before running setup.`);
    } finally {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
  }
}

export function tunnelEndpoint(output, port) {
  const portNumber = Number(port);
  const line = output.split(/\r?\n/).find((value) => value.includes(`Hosting port ${portNumber} at `));
  for (const candidate of line?.match(/https:\/\/[^\s,]+/g) ?? []) {
    let url;
    try { url = new URL(candidate); }
    catch { continue; }
    if (url.hostname.endsWith(".devtunnels.ms") && url.hostname.includes(`-${portNumber}.`)
      && !url.port && !url.username && !url.password && url.pathname === "/"
      && !url.search && !url.hash) return `${url.origin}/api/messages`;
  }
}

export async function hostTunnel({ id, port, signal, command = "devtunnel", args = ["host", id], timeout = 60_000 }) {
  signal?.throwIfAborted();
  const host = launch(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let timer;
  let onAbort;
  try {
    const endpoint = await Promise.race([
      new Promise((resolve, reject) => {
        const receive = (chunk) => {
          output = (output + chunk.toString()).slice(-16_384);
          const endpoint = tunnelEndpoint(output, port);
          if (endpoint && output.includes("Ready to accept connections for tunnel:")) resolve(endpoint);
        };
        host.child.stdout.on("data", receive);
        host.child.stderr.on("data", receive);
        timer = setTimeout(() => reject(new Error("Timed out waiting for the dev tunnel to become ready.")), timeout);
        onAbort = () => reject(signal.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      }),
      host.exited.then(() => { throw new Error("Dev tunnel stopped before becoming ready. Check devtunnel login and the tunnel ID."); }),
    ]);
    host.endpoint = endpoint;
    return host;
  } catch (error) {
    await host.stop();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function runBridge({ root, env, tunnel, signal, log = console.log, timeout = 60_000,
  args = ["--env-file", join(root, ".env"), join(root, "src", "server.js")] }) {
  signal?.throwIfAborted();
  const bridge = launch(process.execPath, args, {
    cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  let timer;
  let onAbort;
  const cancelled = new Promise((resolve) => {
    onAbort = resolve;
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) resolve();
  });
  const stopped = bridge.exited.then((result) => {
    if (result.error || result.code !== 0) throw new Error("The bot stopped unexpectedly. Check the bridge output and Copilot login.");
  });
  const tunnelStopped = tunnel?.exited.then(() => { throw new Error("The dev tunnel stopped. Rerun npm run setup to reconnect."); });
  try {
    const ready = new Promise((resolve, reject) => {
      bridge.child.on("message", (message) => { if (message?.type === "ready") resolve(true); });
      timer = setTimeout(() => reject(new Error("Timed out waiting for the bot to start.")), timeout);
    });
    const started = await Promise.race([ready, stopped, cancelled, ...(tunnelStopped ? [tunnelStopped] : [])]);
    if (!started) {
      if (signal?.aborted) return;
      throw new Error("The bot stopped before becoming ready.");
    }
    clearTimeout(timer);
    const response = await fetch(`http://127.0.0.1:${env.PORT}/health`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok || (await response.json()).ok !== true) throw new Error("The bot health check failed.");
    if (signal?.aborted) return;
    if (bridge.stopped || tunnel?.stopped) throw new Error("The bot or tunnel stopped during startup.");
    log(`${tunnel ? "Bot and tunnel are" : "Bot is"} running. Add the app in Teams, send /help, and keep this terminal open. Ctrl+C stops ${tunnel ? "both" : "the bot"}.`);
    await Promise.race([stopped, cancelled, ...(tunnelStopped ? [tunnelStopped] : [])]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    await bridge.stop();
  }
}
