import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { loadConfig } from "../src/config.js";
import { messagingEndpoint, runCommand, runSetup } from "../src/setup.js";

const userId = "11111111-1111-1111-1111-111111111111";
const credentials = "CLIENT_ID=33333333-3333-3333-3333-333333333333\n"
  + "TENANT_ID=22222222-2222-2222-2222-222222222222\nCLIENT_SECRET='test # secret'\n";

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
    ask: answers([name, userId, "repo", workspace, "n", "y", "https://example.devtunnels.ms"]),
    run: async (command, args) => {
      commands.push([command, args]);
      if (args[0] === "app") {
        await writeFile(args.at(-1), credentials);
      }
    },
  });
  assert.deepEqual(commands.slice(0, 2), [["teams", ["login"]], ["teams", ["status"]]]);
  assert.deepEqual(commands[2][1].slice(0, -1), [
    "app", "create", "--name", name, "--endpoint", "https://example.devtunnels.ms/api/messages", "--env",
  ]);
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
    root, log: () => {}, ask: answers(["", "", "y", "n", "n"]),
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
    ask: answers(["Agent", "", "repo", workspace, "n", "y", "https://example.devtunnels.ms"]),
    run: async (_command, args) => {
      if (args[0] === "app") {
        await writeFile(args.at(-1), credentials);
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
    ask: answers(["Agent", "", "repo", workspace, "n", "y", "https://example.devtunnels.ms"]),
    run: () => assert.fail("Local settings must be validated before registration"),
  }), /must differ/);
  assert.deepEqual(await readdir(join(root, ".data")), []);
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
