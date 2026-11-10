import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { azureRepository, parentWorkItem } from "./author-config.js";
import { authorPolicy } from "./author-policy.js";
import { sessionConfig } from "./session.js";

const bucket = z.object({
  id: z.number().int().min(1).max(7),
  state: z.enum(["clear", "action", "blocked", "disabled"]),
  evidence: z.string().min(1).max(4000),
});
export const sweepSchema = z.object({
  cycleId: z.string().uuid(),
  observedAt: z.string(),
  outcome: z.enum(["clean", "action", "invalid"]),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().min(1).max(3000),
  repositories: z.array(z.object({ alias: z.string(), buckets: z.array(bucket).length(7) })),
});

export function validateSweep(value, { cycleId, startedAt, aliases, parent }) {
  const report = sweepSchema.parse(value);
  const observed = Date.parse(report.observedAt);
  if (report.cycleId !== cycleId || !Number.isFinite(observed)
    || observed < startedAt || observed > Date.now() + 5000) throw new Error("Stale sweep.");
  if (report.repositories.length !== aliases.length
    || new Set(report.repositories.map((repo) => repo.alias)).size !== aliases.length
    || report.repositories.some((repo) => !aliases.includes(repo.alias))) throw new Error("Incomplete inventory.");
  const states = [];
  for (const repo of report.repositories) {
    if (new Set(repo.buckets.map((item) => item.id)).size !== 7) throw new Error("Incomplete sweep.");
    for (const item of repo.buckets) {
      if ((item.state === "disabled" && (item.id !== 7 || parent !== null))
        || (item.id === 7 && parent === null && item.state !== "disabled")) throw new Error("Invalid bucket scope.");
      states.push(item.state);
    }
  }
  if (report.outcome === "clean" && states.some((state) => !["clear", "disabled"].includes(state))) {
    throw new Error("Blocked/actionable sweep is not clean.");
  }
  if (report.outcome === "action" && (!states.includes("action") || states.includes("blocked"))) {
    throw new Error("Incomplete action sweep.");
  }
  return report;
}

export async function verifyAuthorRepositories(repositories, run) {
  for (const [alias, repo] of Object.entries(repositories)) {
    const git = (args) => run("git", ["-C", repo.directory, ...args], { capture: true });
    const top = (await git(["rev-parse", "--show-toplevel"])).trim();
    if ((await realpath(top)).toLowerCase() !== (await realpath(repo.directory)).toLowerCase()) {
      throw new Error(`Checkout mismatch: ${alias}`);
    }
    const worktrees = await git(["worktree", "list", "--porcelain"]);
    if ((worktrees.match(/^worktree /gm) ?? []).length !== 1) throw new Error(`Multiple worktrees: ${alias}`);
    if ((await git(["status", "--porcelain=v1", "--untracked-files=all"])).trim()) throw new Error(`Dirty checkout: ${alias}`);
    const live = azureRepository((await git(["remote", "get-url", "origin"])).trim());
    for (const key of ["organization", "project", "repository"]) {
      if (live[key].toLowerCase() !== repo[key].toLowerCase()) throw new Error(`Remote mismatch: ${alias}`);
    }
  }
}

export class ContinuousAuthor {
  controller;
  session;
  done;
  turnActive = false;
  faulted = false;
  revision = 0;
  state = { running: false, phase: "stopped", cycles: 0, cleanSweeps: 0 };

  constructor({ client, config, workspaces, pending, send, lockPath, run,
    verify = verifyAuthorRepositories, wait = (ms, signal) => delay(ms, undefined, { signal }),
    turnTimeoutMs = 1_800_000 }) {
    Object.assign(this, { client, config, workspaces, pending, send, lockPath, run, verify, wait, turnTimeoutMs });
  }

  get busy() { return Boolean(this.controller) || this.faulted; }

  status() {
    const { lastReport, ...state } = this.state;
    return { ...state, running: this.busy, lastReport: lastReport ? {
      cycleId: lastReport.cycleId, observedAt: lastReport.observedAt, outcome: lastReport.outcome,
      fingerprint: lastReport.fingerprint, summary: lastReport.summary,
    } : null };
  }

  start(args) {
    if (this.busy) return Promise.reject(new Error("An Author is already running or stopping."));
    const starting = this.begin(args);
    this.starting = starting;
    return starting.finally(() => { if (this.starting === starting) this.starting = undefined; });
  }

  async begin({ parentWorkItem: parent, aliases } = {}) {
    if (this.busy) throw new Error("An Author is already running or stopping.");
    if (!this.config) throw new Error("Run plugin setup and configure continuous author repositories first.");
    aliases ??= Object.keys(this.config.repositories);
    if (!Array.isArray(aliases) || !aliases.length || new Set(aliases).size !== aliases.length
      || aliases.some((alias) => !Object.hasOwn(this.config.repositories, alias))) throw new Error("Unknown author repository.");
    const repositories = Object.fromEntries(aliases.map((alias) => [alias, {
      ...this.config.repositories[alias], directory: this.workspaces.get(alias), adoptedPullRequests: [],
    }]));
    const item = parentWorkItem(parent, Object.values(repositories));
    const controller = new AbortController();
    this.controller = controller;
    this.state = { running: true, phase: "starting", aliases, parent: item, cycles: 0, cleanSweeps: 0 };
    let lock;
    try {
      await mkdir(dirname(this.lockPath), { recursive: true });
      try { lock = await open(this.lockPath, "wx", 0o600); }
      catch (error) {
        if (error.code === "EEXIST") throw new Error("Author lock exists. Stop the other runner; remove a stale author.lock only after confirming its process has exited.");
        throw error;
      }
      await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await this.verify(repositories, this.run);
      if (controller.signal.aborted) throw new Error("Author start cancelled.");
      await this.send(`Continuous Author starting for ${aliases.join(", ")}. `
        + `Findings parent: ${item ? `${item.organization} #${item.id}` : "none"}. `
        + "Use /author stop to stop. Permissions and questions are answered here in Teams.");
      this.repositories = repositories;
      this.done = this.loop(controller).finally(async () => {
        this.turnActive = false;
        this.pending.cancelAll();
        if (!this.faulted) {
          await this.session?.disconnect();
          this.session = undefined;
          await lock.close();
          await unlink(this.lockPath);
          this.controller = undefined;
          this.state.phase = "stopped";
          this.state.nextPoll = null;
        }
      });
      void this.done.catch(() => {
        this.faulted = true;
        this.state.phase = "faulted; restart the bridge before running more work";
      });
      return this.status();
    } catch (error) {
      if (lock) {
        await lock.close();
        await unlink(this.lockPath);
      }
      this.controller = undefined;
      this.state.phase = "stopped";
      throw error;
    }
  }

  adopt(alias, id) {
    if (!this.controller || this.controller.signal.aborted || this.faulted) throw new Error("Start an Author first.");
    if (!this.repositories || !Object.hasOwn(this.repositories, alias)
      || !Number.isSafeInteger(id) || id < 1) throw new Error("Unknown repository or invalid PR ID.");
    const adopted = this.repositories[alias].adoptedPullRequests;
    if (!adopted.includes(id)) {
      adopted.push(id);
      this.revision++;
      this.state.cleanSweeps = 0;
    }
    return { adopted: { alias, id }, effective: "next fresh sweep" };
  }

  async loop(controller) {
    const signal = controller.signal;
    let fingerprint;
    let announcement;
    while (!signal.aborted) {
      const startedAt = Date.now();
      const cycleId = randomUUID();
      const revision = this.revision;
      this.state.phase = "sweeping";
      this.state.nextPoll = null;
      this.state.cycles++;
      let report;
      try {
        await this.verify(this.repositories, this.run);
        if (signal.aborted) break;
        this.turnActive = true;
        if (!this.session) {
          this.session = await this.client.createSession(sessionConfig({
            paths: Object.values(this.repositories).map((repo) => repo.directory),
            pending: this.pending, send: this.send,
            isActive: () => this.turnActive && !signal.aborted,
            instructions: authorPolicy,
          }));
          if (this.session.permissionModeResult?.mode !== "manual") {
            await this.session.disconnect();
            this.session = undefined;
            throw new Error("Manual permission mode was not accepted.");
          }
        }
        if (signal.aborted) break;
        const response = await this.session.sendAndWait({
          prompt: JSON.stringify({
            task: "Perform ONE complete fresh seven-bucket Author sweep, act by priority, then return the structured report. Do not end the continuous mission.",
            cycleId, startedAt: new Date(startedAt).toISOString(),
            engineer: this.config.engineer, repositories: this.repositories,
            parent: this.state.parent, sessionId: this.session.sessionId,
            previousCycle: this.state.lastOutcome ?? null,
          }),
          responseSchema: z.toJSONSchema(sweepSchema),
        }, this.turnTimeoutMs);
        report = validateSweep(JSON.parse(response?.data.content ?? ""), {
          cycleId, startedAt, aliases: this.state.aliases, parent: this.state.parent,
        });
        await this.verify(this.repositories, this.run);
        if (signal.aborted) break;
        if (revision !== this.revision) throw new Error("Portfolio scope changed during sweep.");
        this.state.cleanSweeps = report.outcome === "clean"
          ? (fingerprint === report.fingerprint ? this.state.cleanSweeps + 1 : 1) : 0;
        fingerprint = report.fingerprint;
        this.state.lastOutcome = report.outcome;
        this.state.lastReport = report;
        this.state.blocker = null;
      } catch (error) {
        report = undefined;
        if (this.turnActive) {
          try { await this.session?.abort(); }
          catch {
            this.faulted = true;
            this.state.phase = "faulted; cancellation unconfirmed; restart the bridge";
            break;
          }
        }
        if (signal.aborted) break;
        this.state.cleanSweeps = 0;
        fingerprint = undefined;
        this.state.lastOutcome = "invalid";
        this.state.blocker = /^(Dirty checkout|Multiple worktrees|Checkout mismatch|Remote mismatch): [a-z0-9-]+$/.test(error.message)
          ? error.message : "Sweep failed, timed out, or returned incomplete/stale evidence.";
      } finally {
        this.turnActive = false;
        this.pending.cancelAll();
      }
      if (signal.aborted) break;
      const key = report?.outcome === "action" ? `${cycleId}:action`
        : `${this.state.lastOutcome}:${fingerprint ?? "blocked"}`;
      if (announcement !== key && (this.state.lastOutcome !== "clean" || this.state.cleanSweeps >= 3)) {
        try {
          await this.send(this.state.lastOutcome === "invalid"
            ? `Author sweep invalid: ${this.state.blocker ?? "incomplete live evidence"}. It does not count as clean. Check authentication, permissions, service data, and local logs. I will retry at the next poll.`
            : this.state.lastOutcome === "action" ? `[Copilot][Author] ${report.summary}`
              : "Author reports three fresh no-action sweeps. Watching for changes; this mission remains active.");
          announcement = key;
        } catch {
          this.state.cleanSweeps = 0;
          this.state.lastOutcome = "invalid";
        }
      }
      if (this.state.lastOutcome === "invalid" || this.state.cleanSweeps >= 3) {
        this.state.phase = "waiting";
        this.state.nextPoll = new Date(Date.now() + this.config.pollIntervalMs).toISOString();
        try { await this.wait(this.config.pollIntervalMs, signal); }
        catch { if (!signal.aborted) throw new Error("Author polling failed."); }
        this.state.cleanSweeps = 0;
      }
    }
  }

  async stop() {
    if (this.faulted) throw new Error("Author stop could not be confirmed. Restart the bridge before further work.");
    if (!this.controller) return this.status();
    this.controller.abort();
    this.pending.cancelAll();
    if (this.starting) await this.starting.catch(() => {});
    if (this.turnActive) {
      try { await this.session?.abort(); }
      catch {
        this.faulted = true;
        this.state.phase = "faulted; cancellation unconfirmed; restart the bridge";
        throw new Error("Author cancellation could not be confirmed. Restart the bridge before further work.");
      }
    }
    await this.done;
    if (this.faulted) throw new Error("Author stop could not be confirmed. Restart the bridge before further work.");
    return this.status();
  }
}
