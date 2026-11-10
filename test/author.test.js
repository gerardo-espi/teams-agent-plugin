import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { azureRepository, parentWorkItem, setupAuthor, validateAuthorConfig, workspaceDirectory } from "../src/author-config.js";
import { ContinuousAuthor, validateSweep, verifyAuthorRepositories } from "../src/author.js";
import { WorkspaceAgent } from "../src/agent.js";
import { PendingRequests } from "../src/pending.js";

const repo = {
  organization: "https://dev.azure.com/example", project: "Project", repository: "repo",
  repositoryId: "11111111-1111-4111-8111-111111111111", targetRef: "refs/heads/main", rules: [],
};
const config = () => ({
  engineer: "test@example.test", pollIntervalMs: 300_000, repositories: { repo: { ...repo } },
});
const until = async (condition) => {
  const end = Date.now() + 4000;
  while (!condition()) {
    if (Date.now() > end) throw new Error("Condition did not settle.");
    await new Promise(setImmediate);
  }
};

function reportFor(prompt, overrides = {}) {
  return {
    cycleId: prompt.cycleId, observedAt: new Date().toISOString(),
    outcome: "clean", fingerprint: "a".repeat(64), summary: "No actionable changes.",
    repositories: Object.keys(prompt.repositories).map((alias) => ({
      alias, buckets: Array.from({ length: 7 }, (_, index) => ({
        id: index + 1, state: index === 6 && prompt.parent === null ? "disabled" : "clear",
        evidence: "Test-only live-state fixture.",
      })),
    })),
    ...overrides,
  };
}

async function fixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "teams-author-")));
  const messages = [];
  const turns = [];
  const sleeps = [];
  let created = 0;
  let aborted = 0;
  let disconnected = 0;
  const session = {
    sessionId: "22222222-2222-4222-8222-222222222222",
    permissionModeResult: { mode: "manual" },
    sendAndWait: async ({ prompt, responseSchema }) => {
      assert.equal(responseSchema.type, "object");
      const task = JSON.parse(prompt);
      turns.push(task);
      const report = options.respond ? await options.respond(task, turns.length) : reportFor(task);
      return { data: { content: JSON.stringify(report) } };
    },
    abort: async () => { aborted++; },
    disconnect: async () => { disconnected++; },
  };
  const pending = new PendingRequests();
  const author = new ContinuousAuthor({
    client: { createSession: async (value) => {
      created++;
      assert.equal(value.permissionMode, "manual");
      assert.equal(value.enableConfigDiscovery, false);
      assert.equal(value.enableFileHooks, false);
      return session;
    } },
    config: config(), workspaces: new Map([["repo", directory]]),
    pending, send: async (message) => { messages.push(message); },
    lockPath: join(directory, "state", "author.lock"),
    verify: async () => {}, run: () => assert.fail("Unexpected CLI call"),
    wait: (ms, signal) => new Promise((resolve) => {
      const finish = () => {
        signal.removeEventListener("abort", finish);
        resolve();
      };
      signal.addEventListener("abort", finish, { once: true });
      sleeps.push({ ms, resume: finish });
    }),
    ...options.controller,
  });
  t.after(async () => {
    await author.stop();
    await rm(directory, { recursive: true, force: true });
  });
  return { author, pending, session, directory, messages, turns, sleeps,
    counts: () => ({ created, aborted, disconnected }) };
}

test("three fresh clean sweeps wait, automatically resume the SAME session, and stop without another poll", async (t) => {
  const f = await fixture(t);
  await f.author.start({ parentWorkItem: "none" });
  await until(() => f.sleeps.length === 1);
  assert.equal(f.turns.length, 3);
  assert.equal(new Set(f.turns.map((turn) => turn.cycleId)).size, 3);
  assert.equal(f.author.status().phase, "waiting");
  assert.equal(f.sleeps[0].ms, 300_000);
  await assert.rejects(f.author.start({ parentWorkItem: null }), /already/);
  f.sleeps[0].resume();
  await until(() => f.sleeps.length === 2);
  assert.equal(f.turns.length, 6);
  assert.equal(f.counts().created, 1);
  assert.equal(f.messages.filter((text) => text.includes("three fresh")).length, 1);
  await f.author.stop();
  assert.equal(f.author.busy, false);
  assert.equal(f.counts().disconnected, 1);
  await assert.rejects(stat(f.author.lockPath), { code: "ENOENT" });
});

test("actions and live fingerprint changes reset the three-sweep threshold", async (t) => {
  const f = await fixture(t, {
    respond: (task, count) => {
      const result = reportFor(task, { fingerprint: (count >= 5 ? "b" : "a").repeat(64) });
      if (count === 2) {
        result.outcome = "action";
        result.repositories[0].buckets[0].state = "action";
      }
      return result;
    },
  });
  await f.author.start({ parentWorkItem: null });
  await until(() => f.sleeps.length === 1);
  assert.equal(f.turns.length, 7);
  assert.equal(f.author.state.cleanSweeps, 3);
});

test("invalid or stale reports never count as clean and abort before retrying", async (t) => {
  const f = await fixture(t, {
    respond: (task, count) => count === 1 ? reportFor(task, { cycleId: "33333333-3333-4333-8333-333333333333" }) : reportFor(task),
  });
  await f.author.start({ parentWorkItem: null });
  await until(() => f.sleeps.length === 1);
  assert.equal(f.author.state.cleanSweeps, 0);
  assert.equal(f.author.state.lastOutcome, "invalid");
  assert.equal(f.counts().aborted, 1);
  f.sleeps[0].resume();
  await until(() => f.sleeps.length === 2);
  assert.equal(f.turns.length, 4);
});

test("sweep reports must cover every repository and seven unique buckets without concealing blockers", () => {
  const task = { cycleId: "22222222-2222-4222-8222-222222222222", repositories: { repo }, parent: null };
  const context = { cycleId: task.cycleId, startedAt: Date.now() - 1000, aliases: ["repo"], parent: null };
  assert.equal(validateSweep(reportFor(task), context).outcome, "clean");
  for (const change of [
    (r) => { r.repositories = []; },
    (r) => { r.repositories[0].buckets[0].id = 2; },
    (r) => { r.repositories[0].buckets[0].state = "blocked"; },
    (r) => { r.repositories[0].buckets[0].state = "disabled"; },
    (r) => { r.observedAt = "2020-01-01T00:00:00Z"; },
    (r) => { r.fingerprint = "invented"; },
  ]) {
    const report = reportFor(task);
    change(report);
    assert.throws(() => validateSweep(report, context));
  }
});

test("a second runner cannot acquire the same lock, and parent selection is required on EVERY start", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.author.start(), /parent/);
  await f.author.start({ parentWorkItem: "123" });
  await until(() => f.sleeps.length === 1);
  const second = new ContinuousAuthor({
    config: config(), workspaces: new Map([["repo", f.directory]]),
    lockPath: f.author.lockPath,
  });
  await assert.rejects(second.start({ parentWorkItem: null }), /lock exists/);
  assert.equal(JSON.parse(await readFile(f.author.lockPath)).pid, process.pid);
  await f.author.stop();
  await assert.rejects(f.author.start(), /parent/);
  await f.author.start({ parentWorkItem: "456" });
  await until(() => f.sleeps.length === 2);
  assert.equal(f.author.state.parent.id, 456);
});

test("stop during initial verification cancels startup and releases its lock", async (t) => {
  let release;
  const verified = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { controller: { verify: () => verified } });
  const start = f.author.start({ parentWorkItem: null });
  const rejection = assert.rejects(start, /cancelled/);
  await until(() => f.author.state.phase === "starting");
  const stop = f.author.stop();
  release();
  await Promise.all([stop, rejection]);
  assert.equal(f.author.busy, false);
  assert.equal(f.turns.length, 0);
});

test("runtime that refuses manual permissions never receives an Author prompt, even on retry", async (t) => {
  const f = await fixture(t);
  f.session.permissionModeResult.mode = "allow-all";
  await f.author.start({ parentWorkItem: null });
  await until(() => f.sleeps.length === 1);
  f.sleeps[0].resume();
  await until(() => f.sleeps.length === 2);
  assert.equal(f.turns.length, 0);
  assert.equal(f.author.state.lastOutcome, "invalid");
});

test("adoption adds only a configured repository PR to the next fresh sweep", async (t) => {
  const f = await fixture(t);
  await f.author.start({ parentWorkItem: null });
  await until(() => f.sleeps.length === 1);
  assert.throws(() => f.author.adopt("outside", 42));
  f.author.adopt("repo", 42);
  f.author.adopt("repo", 42);
  assert.equal(f.author.state.cleanSweeps, 0);
  f.sleeps[0].resume();
  await until(() => f.sleeps.length === 2);
  assert.deepEqual(f.turns[3].repositories.repo.adoptedPullRequests, [42]);
});

test("checkout verification rejects additional worktrees, local dirt, and changed remotes without modifying files", async (t) => {
  const f = await fixture(t);
  for (const problem of ["worktrees", "dirty", "remote", "none"]) {
    const calls = [];
    const run = async (command, args) => {
      assert.equal(command, "git");
      assert.deepEqual(args.slice(0, 2), ["-C", f.directory]);
      calls.push(args[2]);
      if (args[2] === "rev-parse") return f.directory;
      if (args[2] === "worktree") return `worktree ${f.directory}\n` + (problem === "worktrees" ? "worktree C:\\other\n" : "");
      if (args[2] === "status") return problem === "dirty" ? "?? user-file.txt" : "";
      return `https://dev.azure.com/example/Project/_git/${problem === "remote" ? "outside" : "repo"}`;
    };
    const verify = verifyAuthorRepositories({ repo: { ...repo, directory: f.directory } }, run);
    if (problem === "none") await verify;
    else await assert.rejects(verify);
    assert.ok(!calls.includes("checkout") && !calls.includes("reset"));
  }
});

test("Azure repository mappings support HTTPS and SSH, validate scope, and reject credential-bearing URLs", () => {
  for (const url of ["https://dev.azure.com/example/Project/_git/repo",
    "https://example.visualstudio.com/Project/_git/repo",
    "git@ssh.dev.azure.com:v3/example/Project/repo",
    "ssh://git@ssh.dev.azure.com/v3/example/Project/repo"]) {
    assert.deepEqual(azureRepository(url), {
      organization: repo.organization, project: repo.project, repository: repo.repository,
    });
  }
  assert.throws(() => azureRepository("https://user:secret@dev.azure.com/example/Project/_git/repo"));
  assert.throws(() => parentWorkItem("123", [repo, { ...repo, organization: "https://dev.azure.com/other" }]));
  assert.throws(() => parentWorkItem("https://dev.azure.com/other/Project/_workitems/edit/123", [repo]));
  assert.equal(parentWorkItem("https://dev.azure.com/example/Project/_workitems/edit/123", [repo]).id, 123);
  assert.equal(parentWorkItem("https://example.visualstudio.com/Project/_workitems/edit/123", [repo]).id, 123);
  assert.throws(() => validateAuthorConfig(config(), new Map([["outside", "C:\\outside"]])));
});

test("setup collects repository mappings and per-repository target rules without product-specific defaults", async (t) => {
  const f = await fixture(t);
  const settings = { workspaces: { gc2: f.directory } };
  const values = ["test@example.test", "main", "component/", "official/component"];
  const confirmations = [true, true, true, false];
  await setupAuthor({
    config: settings, log: () => {},
    prompt: async (_label, _fallback, validate) => {
      const value = values.shift();
      assert.equal(validate(value), true);
      return value;
    },
    yes: async () => confirmations.shift(),
    run: async (_command, args) => {
      if (args.includes("--show-toplevel")) return f.directory;
      if (args.includes("get-url")) return "https://dev.azure.com/example/Project/_git/repo";
      if (args[0] === "repos") return JSON.stringify({ id: repo.repositoryId, defaultBranch: "refs/heads/main" });
    },
  });
  assert.equal(settings.author.repositories.gc2.repositoryId, repo.repositoryId);
  assert.deepEqual(settings.author.repositories.gc2.rules, [{
    pathPrefix: "component/", targetRef: "refs/heads/official/component", isolatedHistory: true,
  }]);
  assert.equal(values.length, 0);
});

test("missing checkout is cloned only after explicit confirmation, with arguments passed separately", async (t) => {
  const f = await fixture(t);
  const destination = join(f.directory, "new repo & spaces");
  const remote = "https://example@dev.azure.com/example/Project/_git/repo";
  const values = [destination, remote];
  let clones = 0;
  const options = {
    prompt: async (_label, _fallback, validate) => {
      const value = values.shift();
      assert.equal(await validate(value), true);
      return value;
    },
    yes: async () => true,
    run: async (command, args) => {
      clones++;
      assert.equal(command, "git");
      assert.deepEqual(args, ["clone", "--", remote, destination]);
      await mkdir(destination);
    },
  };
  assert.equal((await workspaceDirectory(options)).toLowerCase(), destination.toLowerCase());
  assert.equal(clones, 1);
  values.push(join(f.directory, "declined"), "https://example.test/repo");
  await assert.rejects(workspaceDirectory({ ...options, yes: async () => false }), /cancelled/);
  assert.equal(clones, 1);
});

test("one Author session covers multiple configured repositories and requires all their buckets", async (t) => {
  const f = await fixture(t);
  f.author.config.repositories.office = { ...repo, repository: "Office",
    repositoryId: "33333333-3333-4333-8333-333333333333" };
  f.author.workspaces.set("office", join(f.directory, "Office"));
  await f.author.start({ parentWorkItem: "123" });
  await until(() => f.sleeps.length === 1);
  assert.deepEqual(f.author.state.aliases, ["repo", "office"]);
  assert.deepEqual(Object.keys(f.turns[0].repositories), ["repo", "office"]);
  assert.equal(f.author.state.lastReport.repositories.length, 2);
  assert.equal(f.counts().created, 1);
});

test("scope adoption during an in-flight sweep invalidates its report rather than counting it clean", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { respond: async (task) => {
    await gate;
    return reportFor(task);
  } });
  await f.author.start({ parentWorkItem: null });
  await until(() => f.turns.length === 1);
  f.author.adopt("repo", 42);
  release();
  await until(() => f.sleeps.length === 1);
  assert.equal(f.author.state.lastOutcome, "invalid");
  assert.equal(f.author.state.cleanSweeps, 0);
});

test("adoption during post-sweep checkout verification also invalidates the old-scope report", async (t) => {
  let release;
  let checks = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { controller: { verify: async () => {
    if (++checks === 3) await gate;
  } } });
  await f.author.start({ parentWorkItem: null });
  await until(() => checks === 3);
  f.author.adopt("repo", 42);
  release();
  await until(() => f.sleeps.length === 1);
  assert.equal(f.author.state.lastOutcome, "invalid");
  assert.equal(f.author.state.cleanSweeps, 0);
});

test("stop aborts an active turn and cancels pending approval questions before releasing ownership", async (t) => {
  const f = await fixture(t);
  let release;
  f.session.sendAndWait = () => new Promise((resolve) => { release = resolve; });
  f.session.abort = async () => { release({ data: { content: "" } }); };
  await f.author.start({ parentWorkItem: null });
  await until(() => typeof release === "function");
  const approval = f.pending.request("permission", "test command", async () => {});
  await f.author.stop();
  assert.equal(await approval, null);
  assert.equal(f.author.busy, false);
  assert.equal(f.sleeps.length, 0);
});

test("stop during session creation waits for it, disconnects, and never sends an Author turn", async (t) => {
  const f = await fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const create = f.author.client.createSession;
  f.author.client.createSession = async (options) => { await gate; return create(options); };
  await f.author.start({ parentWorkItem: null });
  await until(() => f.author.turnActive);
  const stop = f.author.stop();
  release();
  await stop;
  assert.equal(f.turns.length, 0);
  assert.equal(f.counts().disconnected, 1);
  assert.equal(f.author.busy, false);
});

test("Teams start asks for a parent every time, blocks normal work, and keeps stop/status responsive", async () => {
  const messages = [];
  const starts = [];
  const author = {
    config: config(), busy: false,
    status() { return { phase: this.busy ? "waiting" : "stopped" }; },
    async start(args) { starts.push(args); this.busy = true; },
    async stop() { this.busy = false; },
  };
  const agent = new WorkspaceAgent({
    client: {}, workspaces: new Map([["repo", "C:\\repo"]]), author,
    send: async (text) => { messages.push(text); },
  });
  for (const parent of ["123", "none"]) {
    await agent.handle("/author start");
    const id = [...agent.pending.items.keys()][0];
    assert.ok(id);
    await assert.rejects(agent.controlAuthor("start", { parentWorkItem: null }), /in progress/);
    await agent.handle(`/answer ${id} ${parent}`);
    await agent.authorStartDone;
    await agent.handle("edit the repository");
    assert.match(messages.at(-1), /Author owns/);
    await agent.handle("/author status");
    assert.match(messages.at(-1), /waiting/);
    await agent.handle("/author stop");
  }
  assert.deepEqual(starts, [{ parentWorkItem: "123" }, { parentWorkItem: "none" }]);
  await agent.handle("/author start");
  await agent.handle("/author stop");
  assert.equal(agent.pending.items.size, 0);
  assert.equal(starts.length, 2);
});
