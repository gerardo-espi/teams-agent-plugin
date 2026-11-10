import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { z } from "zod";
import { parsePort } from "./config.js";

const root = new URL("..\\", import.meta.url);
let env = {};
try {
  env = parseEnv(await readFile(new URL(".env", root), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
for (const key of ["BRIDGE_TOKEN", "NOTIFY_PORT"]) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
if (!/^[a-f0-9]{64}$/i.test(env.BRIDGE_TOKEN ?? "")) {
  throw new Error("Configure BRIDGE_TOKEN in the plugin's .env file.");
}
const port = parsePort(env.NOTIFY_PORT ?? "3979");
const server = new McpServer({ name: "teams-agent", version: "0.3.0" });
server.registerTool("notify", {
  description: "Send an update to the configured user's personal Teams chat as the devbox bot, never as the user.",
  inputSchema: { message: z.string().trim().min(1).max(12_000) },
}, async ({ message }) => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/notify`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.BRIDGE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Bridge returned HTTP ${response.status}`);
    return { content: [{ type: "text", text: "Message accepted by Teams." }] };
  } catch {
    return {
      isError: true,
      content: [{ type: "text", text: "Delivery failed. Check the bridge is running and send the bot a personal Teams message first." }],
    };
  }
});
for (const [action, description, inputSchema] of [
  ["start", "Start one continuous PR Author on the devbox. Ask the user for the ADO parent work-item URL/ID EVERY start, or explicit none; never reuse an old parent. Requires configured repositories and the running, paired Teams bridge. Approval questions arrive in Teams.", {
    parentWorkItem: z.string().trim().min(1).max(2048).nullable(),
    aliases: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1).optional(),
  }],
  ["status", "Inspect the shared devbox PR Author; does not start another agent.", {}],
  ["stop", "Stop the shared continuous PR Author. Already completed actions are not undone.", {}],
  ["adopt", "Explicitly adopt a PR in a configured repository into the running Author portfolio.", {
    alias: z.string().regex(/^[a-z0-9-]+$/), id: z.number().int().positive(),
  }],
]) {
  server.registerTool(`author_${action}`, { description, inputSchema }, async (args) => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/author/${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.BRIDGE_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(args), signal: AbortSignal.timeout(30_000), redirect: "error",
      });
      const result = await response.json();
      if (!response.ok) return { isError: true, content: [{ type: "text", text: result.error ?? "Author action rejected." }] };
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch {
      return { isError: true, content: [{ type: "text",
        text: "Author action could not be confirmed. Check the bridge and author_status before retrying; no duplicate runner was intentionally started." }] };
    }
  });
}
await server.connect(new StdioServerTransport());
