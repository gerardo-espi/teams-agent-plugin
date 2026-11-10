import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadConfig(root, env = process.env) {
  for (const key of ["CLIENT_ID", "TENANT_ID", "ALLOWED_USER_ID"]) {
    if (!uuid.test(env[key] ?? "")) throw new Error(`${key} must be a UUID in .env.`);
  }
  if (!env.CLIENT_SECRET?.trim()) throw new Error("CLIENT_SECRET is required.");
  if (!/^[a-f0-9]{64}$/i.test(env.BRIDGE_TOKEN ?? "")) {
    throw new Error("BRIDGE_TOKEN must be 32 random bytes encoded as 64 hex characters.");
  }
  const config = JSON.parse(await readFile(new URL("config.json", root), "utf8"));
  const entries = Object.entries(config.workspaces ?? {});
  if (!entries.length) throw new Error("Configure at least one workspace in config.json.");
  const workspaces = new Map();
  for (const [name, path] of entries) {
    if (!/^[a-z0-9-]+$/.test(name) || typeof path !== "string" || !isAbsolute(path)) {
      throw new Error("Workspace aliases must be lowercase names with absolute directory paths.");
    }
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error(`Not a directory: ${name}`);
    workspaces.set(name, canonical);
  }
  const port = parsePort(env.PORT ?? "3978");
  const notifyPort = parsePort(env.NOTIFY_PORT ?? "3979");
  if (port === notifyPort) throw new Error("PORT and NOTIFY_PORT must differ.");
  return {
    clientId: env.CLIENT_ID.toLowerCase(),
    clientSecret: env.CLIENT_SECRET,
    tenantId: env.TENANT_ID.toLowerCase(),
    userId: env.ALLOWED_USER_ID.toLowerCase(),
    token: env.BRIDGE_TOKEN,
    port,
    notifyPort,
    workspaces,
  };
}

export function parsePort(value) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error("Port must be an integer between 1 and 65535.");
  }
  return Number(value);
}

export function isAllowedActivity(activity, config) {
  const tenant = activity.conversation?.tenantId ?? activity.channelData?.tenant?.id;
  return activity.channelId === "msteams"
    && activity.conversation?.conversationType === "personal"
    && typeof activity.conversation.id === "string"
    && activity.from?.aadObjectId?.toLowerCase() === config.userId
    && tenant?.toLowerCase() === config.tenantId
    && activity.recipient?.id === `28:${config.clientId}`;
}

export function validateServiceUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || url.search || url.hash
    || !["smba.trafficmanager.net", "smba.infra.teams.microsoft.com"].includes(url.hostname)) {
    throw new Error("Unexpected Teams service URL. This bridge supports the public Microsoft cloud.");
  }
  return url.href;
}
