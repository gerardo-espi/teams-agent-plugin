import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { WorkspaceAgent } from "../src/agent.js";
import { isAllowedActivity, loadConfig, validateServiceUrl } from "../src/config.js";
import { createNotificationServer } from "../src/notifications.js";
import { PendingRequests } from "../src/pending.js";

const config = {
  userId: "11111111-1111-1111-1111-111111111111",
  tenantId: "22222222-2222-2222-2222-222222222222",
  clientId: "33333333-3333-3333-3333-333333333333",
};
const activity = () => ({
  channelId: "msteams",
  conversation: { id: "personal-chat", conversationType: "personal", tenantId: config.tenantId },
  from: { aadObjectId: config.userId },
  recipient: { id: `28:${config.clientId}` },
});

test("only the configured tenant/user's personal bot chat can issue instructions", () => {
  assert.equal(isAllowedActivity(activity(), config), true);
  for (const change of [
    { channelId: "emulator" },
    { from: { aadObjectId: "another-user" } },
    { recipient: { id: "another-bot" } },
    { conversation: { ...activity().conversation, tenantId: "another-tenant" } },
    { conversation: { ...activity().conversation, conversationType: "groupChat" } },
    { conversation: { ...activity().conversation, id: undefined } },
  ]) {
    assert.equal(isAllowedActivity({ ...activity(), ...change }, config), false);
  }
  const alternate = activity();
  delete alternate.conversation.tenantId;
  alternate.channelData = { tenant: { id: config.tenantId } };
  assert.equal(isAllowedActivity(alternate, config), true);
});

test("service URL preserves the cloud path and cannot exfiltrate bot tokens", () => {
  assert.equal(validateServiceUrl("https://smba.trafficmanager.net/amer/"),
    "https://smba.trafficmanager.net/amer/");
  for (const url of ["http://smba.trafficmanager.net/", "https://example.com/",
    "https://smba.trafficmanager.net.evil.example/", "https://user@smba.trafficmanager.net/",
    "https://smba.trafficmanager.net:8443/", "https://smba.trafficmanager.net/?token=x"]) {
    assert.throws(() => validateServiceUrl(url));
  }
});

test("startup rejects missing identity, weak tokens, and invalid workspace configuration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "teams-agent-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = pathToFileURL(`${directory}\\`);
  const env = {
    CLIENT_ID: config.clientId, TENANT_ID: config.tenantId, ALLOWED_USER_ID: config.userId,
    CLIENT_SECRET: "test-only", BRIDGE_TOKEN: "a".repeat(64),
  };
  await writeFile(join(directory, "config.json"), JSON.stringify({ workspaces: { repo: directory } }));
  const loaded = await loadConfig(root, env);
  assert.equal(loaded.workspaces.size, 1);
  for (const bad of [{ ALLOWED_USER_ID: "" }, { BRIDGE_TOKEN: "short" },
    { CLIENT_SECRET: "" }, { PORT: "NaN" }, { NOTIFY_PORT: "3978" }]) {
    await assert.rejects(loadConfig(root, { ...env, ...bad }));
  }
  await writeFile(join(directory, "config.json"), '{"workspaces":{"repo":"relative"}}');
  await assert.rejects(loadConfig(root, env));
});

test("approval IDs are one-use, typed, and fail closed on timeout or cancellation", async () => {
  const requests = new PendingRequests(25);
  const response = requests.request("permission", "write file", async () => {});
  const id = [...requests.items.keys()][0];
  assert.equal(requests.finish(id, "yes", "question"), false);
  assert.equal(requests.finish(id, true, "permission"), true);
  assert.equal(await response, true);
  assert.equal(requests.finish(id, true, "permission"), false);
  const expired = requests.request("permission", "write file", async () => {});
  assert.equal(await expired, null);
  const cancelled = requests.request("question", "which branch?", async () => {});
  requests.cancelAll();
  assert.equal(await cancelled, null);
  await assert.rejects(requests.request("permission", "write file", async () => {
    throw new Error("Teams offline");
  }));
  assert.equal(requests.items.size, 0);
});

function harness(create) {
  const messages = [];
  const agent = new WorkspaceAgent({
    client: { createSession: create },
    workspaces: new Map([["repo", "C:\\repo"]]),
    send: async (text) => { messages.push(text); },
  });
  return { agent, messages };
}

test("workspace must be explicitly selected; normal turns cannot overlap", async () => {
  let release;
  let created = 0;
  const { agent, messages } = harness(async () => {
    created++;
    return {
      permissionModeResult: { mode: "manual" },
      sendAndWait: () => new Promise((resolve) => { release = resolve; }),
      disconnect: async () => {},
    };
  });
  await agent.handle("make a change");
  assert.match(messages.at(-1), /Select a repository/);
  await agent.handle("/use C:\\other");
  assert.equal(agent.selected, undefined);
  await agent.handle("/use repo");
  await Promise.all([agent.handle("first"), agent.handle("second")]);
  assert.equal(created, 1);
  assert.ok(messages.some((text) => text.includes("A task is running")));
  const done = agent.active.done;
  release({ data: { content: "Finished" } });
  await done;
  assert.equal(messages.at(-1), "Finished");
  assert.equal(agent.active, undefined);
  await agent.stop();
});

test("permissions and questions are answered while a turn is active, including reused sessions", async () => {
  let options;
  let pass = 0;
  const permissions = [];
  const { agent, messages } = harness(async (config) => {
    options = config;
    return {
      permissionModeResult: { mode: "manual" },
      async sendAndWait() {
        pass++;
        permissions.push(await options.onPermissionRequest({ kind: "shell", fullCommandText: "git status" }));
        const answer = await options.onUserInputRequest({ question: "Which branch?", choices: ["main"] });
        return { data: { content: answer.answer } };
      },
      abort: async () => {},
      disconnect: async () => {},
    };
  });
  await agent.handle("/use repo");
  for (let turn = 0; turn < 2; turn++) {
    await agent.handle("inspect the repository");
    const done = agent.active.done;
    while (!agent.pending.items.size) await new Promise(setImmediate);
    const permissionId = [...agent.pending.items.keys()][0];
    await agent.handle(`/approve ${permissionId}`);
    while (![...agent.pending.items.values()].some((item) => item.kind === "question")) {
      await new Promise(setImmediate);
    }
    const questionId = [...agent.pending.items.keys()][0];
    await agent.handle(`/answer ${questionId} main`);
    await done;
    assert.equal(messages.at(-1), "main");
  }
  assert.equal(pass, 2);
  assert.deepEqual(permissions, [
    { kind: "approve-once", approvedInteractively: true },
    { kind: "approve-once", approvedInteractively: true },
  ]);
  assert.equal(options.workingDirectory, "C:\\repo");
  assert.equal(options.permissionMode, "manual");
  assert.equal(options.enableFileHooks, false);
  await agent.stop();
});

test("cancellation invalidates approvals and aborts active work", async () => {
  let aborted = 0;
  let result;
  const { agent } = harness(async (options) => ({
    permissionModeResult: { mode: "manual" },
    async sendAndWait() {
      result = await options.onPermissionRequest({ kind: "write", fileName: "file.js" });
      return { data: { content: "stopped" } };
    },
    abort: async () => { aborted++; },
    disconnect: async () => {},
  }));
  await agent.handle("/use repo");
  await agent.handle("change a file");
  const done = agent.active.done;
  while (!agent.pending.items.size) await new Promise(setImmediate);
  await agent.handle("/cancel");
  await done;
  assert.equal(aborted, 1);
  assert.equal(result.kind, "reject");
  assert.equal(agent.pending.items.size, 0);
  await agent.stop();
});

test("turn failure aborts runtime work before releasing the workspace", async () => {
  let aborted = false;
  const { agent } = harness(async () => ({
    permissionModeResult: { mode: "manual" },
    sendAndWait: async () => { throw new Error("timeout"); },
    abort: async () => { aborted = true; },
    disconnect: async () => {},
  }));
  await agent.handle("/use repo");
  await agent.handle("run a task");
  await agent.active.done;
  assert.equal(aborted, true);
  assert.equal(agent.active, undefined);
  await agent.stop();
});

test("runtime that refuses manual permissions never receives a prompt", async () => {
  let disconnected = false;
  const { agent, messages } = harness(async () => ({
    permissionModeResult: { mode: "allow-all" },
    sendAndWait: async () => { assert.fail("Must not send without manual permissions"); },
    disconnect: async () => { disconnected = true; },
  }));
  await agent.handle("/use repo");
  await agent.handle("change a file");
  await agent.active.done;
  assert.equal(disconnected, true);
  assert.match(messages.at(-1), /Task failed/);
  assert.equal(agent.sessions.size, 0);
  await agent.stop();
});

test("private notifications require the token and propagate delivery failures", async (t) => {
  const sent = [];
  const server = createNotificationServer({
    token: "secret",
    send: async (text) => {
      if (text === "offline") throw new Error("no paired conversation");
      sent.push(text);
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/notify`;
  const post = (body, authorization = "Bearer secret") => fetch(url, {
    method: "POST", headers: { authorization }, body,
  });
  assert.equal((await post('{"message":"hi"}', "Bearer wrong")).status, 401);
  assert.equal((await post("not json")).status, 400);
  assert.equal((await post('{"message":""}')).status, 400);
  assert.equal((await post('{"message":"offline"}')).status, 503);
  assert.equal((await post(JSON.stringify({ message: "x".repeat(33_000) }))).status, 413);
  assert.equal((await post('{"message":"Build finished"}')).status, 200);
  assert.deepEqual(sent, ["Build finished"]);
});
