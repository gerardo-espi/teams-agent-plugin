import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { loadConfig } from "../src/config.js";
import { managedTunnel, messagingEndpoint, runCommand, runSetup } from "../src/setup.js";

const userId = "11111111-1111-1111-1111-111111111111";
const credentials = "CLIENT_ID=33333333-3333-3333-3333-333333333333\n"
  + "TENANT_ID=22222222-2222-2222-2222-222222222222\nCLIENT_SECRET='test # secret'\n";
const teamsAppId = "44444444-4444-4444-4444-444444444444";
const registration = JSON.stringify({ teamsAppId, installLink: `https://teams.microsoft.com/l/app/${teamsAppId}` });

async function createBot(args) {
  await writeFile(args[args.indexOf("--env") + 1], credentials);
  return registration;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "teams-agent-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "repo");
  await mkdir(workspace);
  return { root, workspace };
}

function answers(values) {
  return async (question) => {
    assert.ok(values.length, `Unexpected prompt: ${question}`);
    return values.shift();
  };
}

test("setup registers the requested bot name and produces usable local settings", async (t) => {
  const { root, workspace } = await fixture(t);
  const commands = [];
  const name = "Review & Build 'Agent'";
  await runSetup({
    root, log: () => {},
    ask: answers([name, userId, "repo", workspace, "n", "y", "n", "https://example.devtunnels.ms", "n", "n"]),
    run: async (command, args) => {
      commands.push([command, args]);
      if (args[0] === "app") {
        return createBot(args);
      }
    },
  });
  assert.deepEqual(commands.slice(0, 2), [["teams", ["login"]], ["teams", ["status"]]]);
  assert.deepEqual(commands[2][1].slice(0, 7), [
    "app", "create", "--name", name, "--endpoint", "https://example.devtunnels.ms/api/messages", "--env",
  ]);
  assert.deepEqual(commands[2][1].slice(-2), ["--teams-managed", "--json"]);
  const env = parseEnv(await readFile(join(root, ".env"), "utf8"));
  const loaded = await loadConfig(pathToFileURL(root + sep), env);
  assert.equal(loaded.clientSecret, "test # secret");
  assert.equal(loaded.userId, userId);
  assert.equal(loaded.workspaces.get("repo"), await realpath(workspace));
  assert.match(loaded.token, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(await readFile(join(root, "config.json"), "utf8")).botName, name);
  assert.deepEqual(await readdir(join(root, ".data")), []);
});

test("rerunning setup preserves credentials, token, ports, workspaces and optional settings", async (t) => {
  const { root, workspace } = await fixture(t);
  const token = "a".repeat(64);
  const existingEnv = credentials + `ALLOWED_USER_ID=${userId}\nBRIDGE_TOKEN=${token}\n`
    + 'PORT=4980\nNOTIFY_PORT=4981\nCOPILOT_CLI_PATH="C:\\Program Files\\Copilot\\copilot.exe"\n';
  await writeFile(join(root, ".env"), existingEnv);
  const config = { botName: "Original", workspaces: { repo: workspace }, extra: "keep me" };
  await writeFile(join(root, "config.json"), JSON.stringify(config));
  await runSetup({
    root, log: () => {}, ask: answers(["", "", "y", "n", "n", "n", "n"]),
    run: () => assert.fail("Existing bot must not be re-registered"),
  });
  assert.deepEqual(parseEnv(await readFile(join(root, ".env"), "utf8")), parseEnv(existingEnv));
  assert.deepEqual(JSON.parse(await readFile(join(root, "config.json"), "utf8")), config);
});

test("invalid answers are retried and no configuration is written without bot credentials", async (t) => {
  const { root, workspace } = await fixture(t);
  const logs = [];
  await assert.rejects(runSetup({
    root, log: (message) => logs.push(message),
    ask: answers(["x".repeat(31), "Agent", "not-an-id", userId,
      "../invalid", "repo", join(root, "missing"), workspace, "n", "n"]),
    run: () => assert.fail("No registration expected"),
  }), /credentials are missing/);
  assert.equal(logs.filter((message) => message.startsWith("Invalid ")).length, 4);
  await assert.rejects(readFile(join(root, ".env")), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "config.json")), { code: "ENOENT" });
});

test("registration failure leaves existing settings untouched and retains recovery credentials", async (t) => {
  const { root, workspace } = await fixture(t);
  const original = `ALLOWED_USER_ID=${userId}\n`;
  await writeFile(join(root, ".env"), original);
  const logs = [];
  await assert.rejects(runSetup({
    root, log: (message) => logs.push(message),
    ask: answers(["Agent", "", "repo", workspace, "n", "y", "n", "https://example.devtunnels.ms"]),
    run: async (_command, args) => {
      if (args[0] === "app") {
        await createBot(args);
        throw new Error("CLI interrupted after registration");
      }
    },
  }), /CLI interrupted/);
  assert.equal(await readFile(join(root, ".env"), "utf8"), original);
  const [recovery] = await readdir(join(root, ".data"));
  assert.equal(await readFile(join(root, ".data", recovery, ".env"), "utf8"), credentials);
  assert.ok(logs.some((message) => message.includes("Recovery files are retained")));
  assert.ok(logs.every((message) => !message.includes("test # secret")));
});

test("invalid local ports are rejected before creating a bot", async (t) => {
  const { root, workspace } = await fixture(t);
  await writeFile(join(root, ".env"), `ALLOWED_USER_ID=${userId}\nPORT=3979\n`);
  await assert.rejects(runSetup({
    root, log: () => {},
    ask: answers(["Agent", "", "repo", workspace, "n", "y", "n", "https://example.devtunnels.ms"]),
    run: () => assert.fail("Local settings must be validated before registration"),
  }), /must differ/);
  assert.deepEqual(await readdir(join(root, ".data")), []);
});

test("one setup command hosts the tunnel, registers, opens Teams and starts the bot", async (t) => {
  const { root, workspace } = await fixture(t);
  const events = [];
  const tunnel = {
    endpoint: "https://managed-3978.usw2.devtunnels.ms/api/messages",
    stop: async () => events.push("stop tunnel"),
  };
  await runSetup({
    root, log: () => {},
    ask: answers(["My Assistant", userId, "repo", workspace, "n", "y", "y", "y", "y"]),
    startTunnel: async ({ env }) => {
      assert.equal(env.PORT, "3978");
      events.push("host tunnel");
      return tunnel;
    },
    run: async (command, args) => {
      events.push(command);
      if (args[0] === "app") {
        assert.equal(args[args.indexOf("--endpoint") + 1], tunnel.endpoint);
        return createBot(args);
      }
    },
    startBot: async (options) => {
      assert.equal(options.tunnel, tunnel);
      const saved = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
      assert.equal(saved.teamsAppId, teamsAppId);
      assert.equal(saved.endpoint, tunnel.endpoint);
      assert.equal(saved.botName, "My Assistant");
      events.push("start bot");
    },
  });
  assert.deepEqual(events, ["host tunnel", "teams", "teams", "teams",
    process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open",
    "start bot", "stop tunnel"]);
});

test("tunnel is stopped when registration or bot startup fails", async (t) => {
  for (const failAt of ["registration", "startup"]) {
    const { root, workspace } = await fixture(t);
    let stopped = 0;
    await assert.rejects(runSetup({
      root, log: () => {},
      ask: answers(["Agent", userId, "repo", workspace, "n", "y", "y", "n", "y"]),
      startTunnel: async () => ({
        endpoint: "https://managed-3978.usw2.devtunnels.ms/api/messages", stop: async () => { stopped++; },
      }),
      run: async (_command, args) => {
        if (args[0] === "app") {
          if (failAt === "registration") throw new Error("registration failed");
          return createBot(args);
        }
      },
      startBot: async () => { throw new Error("startup failed"); },
    }), new RegExp(`${failAt} failed`));
    assert.equal(stopped, 1);
  }
});

test("moving an existing bot to a managed tunnel requires confirmation and updates its endpoint", async (t) => {
  const { root, workspace } = await fixture(t);
  await writeFile(join(root, ".env"), credentials + `ALLOWED_USER_ID=${userId}\n`);
  await writeFile(join(root, "config.json"), JSON.stringify({
    botName: "Agent", teamsAppId, workspaces: { repo: workspace }, endpoint: "https://old.example/api/messages",
  }));
  const commands = [];
  const endpoint = "https://managed-3978.usw2.devtunnels.ms/api/messages";
  await runSetup({
    root, log: () => {},
    ask: answers(["", "", "y", "n", "n", "y", "", "y", "n", "n"]),
    startTunnel: async () => ({ endpoint, stop: async () => {} }),
    run: async (command, args) => {
      commands.push([command, args]);
      if (args[0] === "app" && args[1] === "get") return JSON.parse(registration).installLink;
    },
  });
  assert.ok(commands.some(([, args]) => JSON.stringify(args)
    === JSON.stringify(["app", "update", teamsAppId, "--endpoint", endpoint])));
  assert.ok(commands.every(([, args]) => args[1] !== "create"));
});

test("managed tunnel persists its identity, reuses it and refuses extra exposed ports", async (t) => {
  const { root } = await fixture(t);
  await mkdir(join(root, ".data"));
  const env = { PORT: "3978", NOTIFY_PORT: "3979" };
  let exposedPorts = [{ portNumber: 3978, protocol: "http" }];
  const commands = [];
  const options = {
    root, env, log: () => {}, checkPorts: async () => {},
    run: async (_command, args) => {
      commands.push(args);
      if (args[0] === "show") return JSON.stringify({ ports: exposedPorts });
    },
    host: async () => ({ endpoint: "https://managed-3978.usw2.devtunnels.ms/api/messages" }),
  };
  await managedTunnel(options);
  const state = JSON.parse(await readFile(join(root, ".data", "tunnel.json"), "utf8"));
  await managedTunnel(options);
  assert.equal(commands.filter((args) => args[0] === "create").length, 1);
  assert.ok(commands.filter((args) => args[0] === "show").every((args) => args[1] === state.id));
  exposedPorts = [...exposedPorts, { portNumber: 3979, protocol: "http" }];
  await assert.rejects(managedTunnel({
    ...options, host: () => assert.fail("Notification port must never be exposed"),
  }), /unexpected ports/);
});

test("messaging endpoints require HTTPS and reject credentials, unexpected paths and query strings", () => {
  assert.equal(messagingEndpoint("https://example.test/api/messages"), "https://example.test/api/messages");
  for (const value of ["http://example.test", "https://user:pass@example.test",
    "https://example.test/wrong", "https://example.test?token=secret", "https://example.test/#fragment"]) {
    assert.throws(() => messagingEndpoint(value));
  }
});

test("command runner passes shell metacharacters as literal arguments and propagates failures", async (t) => {
  const { root } = await fixture(t);
  const output = join(root, "args.json");
  const literal = `Agent & 'quoted' "$value" ; $(exit 55)`;
  await runCommand(process.execPath, ["-e",
    "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))", output, literal]);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), [literal]);
  await assert.rejects(runCommand(process.execPath, ["-e", "process.exit(3)"]), /did not complete/);
  assert.equal(await runCommand(process.execPath, ["-e", "console.log(JSON.stringify({ok:true}))"],
    { capture: true }), '{"ok":true}\n');
  await assert.rejects(runCommand("teams-setup-nonexistent-command", [], { capture: true }), /Could not start/);
});

test("Windows npm-style command shims receive the bot name without shell expansion",
  { skip: process.platform !== "win32" }, async (t) => {
    const { root } = await fixture(t);
    const script = join(root, "cli.cjs");
    const shim = join(root, "teams.cmd");
    const output = join(root, "args.json");
    await writeFile(script, "require('fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));");
    await writeFile(shim, `@"${process.execPath}" "${script}" %*\r\n`);
    const name = `Bot&echo "quoted" %PATH% !value! ^ ; $(exit 55)`;
    await runCommand(shim, [output, "--name", name]);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), ["--name", name]);
  });
