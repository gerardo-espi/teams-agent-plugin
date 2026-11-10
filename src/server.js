import { CopilotClient } from "@github/copilot-sdk";
import { App, ExpressAdapter } from "@microsoft/teams.apps";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, isAllowedActivity, validateServiceUrl } from "./config.js";
import { WorkspaceAgent } from "./agent.js";
import { createNotificationServer } from "./notifications.js";
import { ContinuousAuthor } from "./author.js";
import { runCommand } from "./setup.js";

const root = new URL("..\\", import.meta.url);
const config = await loadConfig(root);
const stateDir = new URL(".data/", root);
const statePath = new URL("conversation.json", stateDir);
await mkdir(stateDir, { recursive: true });
let reference;
try {
  const saved = JSON.parse(await readFile(statePath, "utf8"));
  if (saved.clientId === config.clientId && saved.tenantId === config.tenantId
    && saved.userId === config.userId && typeof saved.conversationId === "string") {
    reference = { ...saved, serviceUrl: validateServiceUrl(saved.serviceUrl) };
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const credentials = {
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  tenantId: config.tenantId,
};
const outboundApps = new Map();
const send = async (text) => {
  if (!reference) throw new Error("Send the bot a personal Teams message first.");
  let outbound = outboundApps.get(reference.serviceUrl);
  if (!outbound) {
    outbound = new App({ ...credentials, serviceUrl: reference.serviceUrl });
    outboundApps.set(reference.serviceUrl, outbound);
  }
  for (let offset = 0; offset < text.length; offset += 3500) {
    await outbound.send(reference.conversationId, {
      type: "message", text: text.slice(offset, offset + 3500), textFormat: "plain",
    });
  }
};

const childEnv = { ...process.env };
for (const key of ["CLIENT_ID", "CLIENT_SECRET", "TENANT_ID", "ALLOWED_USER_ID", "BRIDGE_TOKEN",
  "COPILOT_ALLOW_ALL", "COPILOT_CLI", "COPILOT_SESSION_ID"]) {
  delete childEnv[key];
}
const client = new CopilotClient({
  mode: "empty",
  baseDirectory: process.env.COPILOT_HOME ?? join(homedir(), ".copilot"),
  workingDirectory: fileURLToPath(root),
  env: childEnv,
});
const agent = new WorkspaceAgent({ client, workspaces: config.workspaces, send });
agent.author = new ContinuousAuthor({
  client, config: config.author, workspaces: config.workspaces, pending: agent.pending, send,
  lockPath: join(process.env.COPILOT_HOME ?? join(homedir(), ".copilot"), "teams-agent", "author.lock"),
  run: runCommand,
});
const adapter = new ExpressAdapter();
const app = new App({ ...credentials, httpServerAdapter: adapter });
adapter.get("/health", (_req, res) => res.json({ ok: true }));
const seen = new Map();
let ingress = Promise.resolve();

app.on("message", async ({ activity }) => {
  if (!isAllowedActivity(activity, config) || !activity.id) return;
  // Serialize only ingress; model work runs separately so approvals remain responsive.
  const operation = ingress.then(async () => {
    const now = Date.now();
    for (const [id, timestamp] of seen) {
      if (now - timestamp > 86_400_000) seen.delete(id);
    }
    if (seen.has(activity.id)) return;
    seen.set(activity.id, now);
    if (seen.size > 10_000) seen.delete(seen.keys().next().value);
    const nextReference = {
      clientId: config.clientId,
      tenantId: config.tenantId,
      userId: config.userId,
      conversationId: activity.conversation.id,
      serviceUrl: validateServiceUrl(activity.serviceUrl),
    };
    if (reference && reference.conversationId !== nextReference.conversationId) return;
    const temporary = new URL("conversation.json.tmp", stateDir);
    await writeFile(temporary, JSON.stringify(nextReference), { mode: 0o600 });
    await rename(temporary, statePath);
    reference = nextReference;
    await agent.handle(activity.text ?? "");
  });
  ingress = operation.catch(() => console.error("Teams instruction could not be processed."));
  await operation;
});

const notifications = createNotificationServer({
  token: config.token, send, author: (action, args) => agent.controlAuthor(action, args),
});
const listen = (server, port) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (notifications.listening) notifications.close();
  await agent.stop().catch(() => console.error("Could not stop an active Copilot task."));
  await Promise.allSettled([app.stop(), client.stop()]);
  if (process.connected) process.disconnect();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
process.on("message", (message) => { if (message?.type === "shutdown") void shutdown(); });

try {
  await client.start();
  await client.ping("teams-agent");
  await app.initialize();
  await listen(adapter.server, config.port);
  await listen(notifications, config.notifyPort);
  console.log(`Teams agent ready on 127.0.0.1:${config.port}. Tunnel only this port.`);
  console.log(`Private notification API on 127.0.0.1:${config.notifyPort}. Do not tunnel it.`);
  process.send?.({ type: "ready" });
} catch (error) {
  console.error(`Startup failed (${error.code ?? error.name}). Check configuration and Copilot login.`);
  await shutdown();
  process.exitCode = 1;
}
