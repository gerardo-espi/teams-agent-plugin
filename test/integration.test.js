import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { App, ExpressAdapter } from "@microsoft/teams.apps";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createNotificationServer } from "../src/notifications.js";

test("Teams endpoint rejects unsigned instructions with bot credentials configured", async (t) => {
  const adapter = new ExpressAdapter();
  const app = new App({
    clientId: "33333333-3333-3333-3333-333333333333",
    clientSecret: "test-only",
    tenantId: "22222222-2222-2222-2222-222222222222",
    httpServerAdapter: adapter,
  });
  let handled = false;
  app.on("message", async () => { handled = true; });
  await app.initialize();
  adapter.server.listen(0, "127.0.0.1");
  await once(adapter.server, "listening");
  t.after(() => app.stop());
  const response = await fetch(`http://127.0.0.1:${adapter.server.address().port}/api/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "message", id: "fake", channelId: "msteams",
      conversation: { id: "fake", conversationType: "personal" },
      text: "execute this command",
    }),
  });
  assert.equal(response.status, 401);
  assert.equal(handled, false);
});

test("plugin MCP process delivers through the private API and reports failures truthfully", async (t) => {
  const messages = [];
  const authorCalls = [];
  const token = "b".repeat(64);
  const server = createNotificationServer({
    token,
    send: async (message) => {
      if (message === "offline") throw new Error("offline");
      messages.push(message);
    },
    author: async (action, args) => {
      authorCalls.push([action, args]);
      if (action === "start" && args.parentWorkItem === "bad") throw new Error("Invalid parent.");
      return { running: action !== "stop", phase: "test fixture" };
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/mcp.js", import.meta.url))],
    env: { ...process.env, BRIDGE_TOKEN: token, NOTIFY_PORT: String(server.address().port) },
    stderr: "pipe",
  });
  const client = new Client({ name: "teams-agent-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "notify"));
  const delivered = await client.callTool({ name: "notify", arguments: { message: "Ready for review" } });
  assert.notEqual(delivered.isError, true);
  assert.deepEqual(messages, ["Ready for review"]);
  const failed = await client.callTool({ name: "notify", arguments: { message: "offline" } });
  assert.equal(failed.isError, true);
  assert.ok(tools.tools.some((tool) => tool.name === "author_start"));
  const started = await client.callTool({ name: "author_start", arguments: { parentWorkItem: "123", aliases: ["gc2"] } });
  assert.notEqual(started.isError, true);
  const status = await client.callTool({ name: "author_status", arguments: {} });
  assert.notEqual(status.isError, true);
  const stopped = await client.callTool({ name: "author_stop", arguments: {} });
  assert.notEqual(stopped.isError, true);
  const adopted = await client.callTool({ name: "author_adopt", arguments: { alias: "gc2", id: 42 } });
  assert.notEqual(adopted.isError, true);
  const rejected = await client.callTool({ name: "author_start", arguments: { parentWorkItem: "bad" } });
  assert.equal(rejected.isError, true);
  const missingParent = await client.callTool({ name: "author_start", arguments: {} });
  assert.equal(missingParent.isError, true);
  assert.deepEqual(authorCalls, [
    ["start", { parentWorkItem: "123", aliases: ["gc2"] }], ["status", {}], ["stop", {}],
    ["adopt", { alias: "gc2", id: 42 }], ["start", { parentWorkItem: "bad" }],
  ]);
  const unauthorized = await fetch(`http://127.0.0.1:${server.address().port}/author/stop`, {
    method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}",
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(authorCalls.length, 5);
});
