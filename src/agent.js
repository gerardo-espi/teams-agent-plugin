import { PendingRequests } from "./pending.js";
import { sessionConfig } from "./session.js";

const help = [
  "I am your devbox agent, with my own Teams bot identity.",
  "/workspaces - list configured repositories",
  "/use <alias> - select a repository",
  "/status - show current workspace and pending requests",
  "/cancel - abort the active request",
  "/reset - start a fresh conversation in this workspace",
  "/author start - continuously maintain all configured PR repositories (asks for parent work item)",
  "/author status or /author stop - inspect or stop the continuous Author",
  "/author adopt <alias> <PR ID> - add a PR to the running portfolio",
  "/approve <id> or /deny <id> - answer a permission request",
  "/answer <id> <text> - answer an agent question",
  "After /use, send a normal message to give me instructions.",
].join("\n");

export class WorkspaceAgent {
  sessions = new Map();
  pending = new PendingRequests();
  selected;
  active;
  closing = false;

  constructor({ client, workspaces, send, author, turnTimeoutMs = 1_800_000 }) {
    this.client = client;
    this.workspaces = workspaces;
    this.send = send;
    this.turnTimeoutMs = turnTimeoutMs;
    this.author = author;
  }

  async handle(text) {
    if (this.closing) return;
    const [command, ...args] = text.trim().split(/\s+/);
    if (!command || command === "/help") return this.send(help);
    if (command === "/approve" || command === "/deny") {
      const ok = args.length === 1 && this.pending.finish(
        args[0], command === "/approve", "permission",
      );
      return this.send(ok ? "Decision received." : "Unknown or expired approval ID.");
    }
    if (command === "/answer") {
      const answer = args.slice(1).join(" ");
      const ok = answer && this.pending.finish(args[0], answer, "question");
      return this.send(ok ? "Answer received." : "Unknown question ID or empty answer.");
    }
    if (command === "/workspaces") {
      return this.send(`Available workspaces: ${[...this.workspaces.keys()].join(", ")}`);
    }
    if (command === "/status") {
      return this.send(`Workspace: ${this.selected ?? "none"}\n`
        + `Running: ${Boolean(this.active)}\nAuthor: ${this.author?.status().phase ?? "not configured"}`
        + `\nPending requests: ${this.pending.items.size}`);
    }
    if (command === "/author") return this.handleAuthor(args);
    if (command === "/cancel") {
      if (this.authorStarting || this.author?.busy) {
        try {
          await this.controlAuthor("stop");
          return this.send("Author stopped. Completed actions are not undone; spawned commands may still need attention.");
        } catch {
          return this.send("Author cancellation could not be confirmed. Restart the bridge before further work.");
        }
      }
      if (!this.active) return this.send("Nothing is running.");
      this.active.cancelled = true;
      this.pending.cancelAll();
      await this.active.session?.abort();
      return this.send("Cancellation requested. Already completed actions are not undone.");
    }
    if (this.authorStarting || this.author?.busy) {
      return this.send("The continuous Author owns the repositories. Use /author status or /author stop first.");
    }
    if (this.active) return this.send("A task is running. Use /status or /cancel first.");
    if (command === "/use") {
      if (args.length !== 1 || !this.workspaces.has(args[0])) {
        return this.send("Unknown workspace. Use /workspaces, then /use <alias>.");
      }
      this.selected = args[0];
      return this.send(`Workspace selected: ${this.selected}`);
    }
    if (command === "/reset") {
      const session = this.sessions.get(this.selected);
      if (session) await session.disconnect();
      this.sessions.delete(this.selected);
      return this.send("Conversation reset. Files and previous actions are unchanged.");
    }
    if (command.startsWith("/")) return this.send("Unknown command. Use /help.");
    if (!this.selected) return this.send("Select a repository first with /use <alias>.");
    if (text.length > 12_000) return this.send("Please keep instructions under 12,000 characters.");

    // Reserve the turn before the first await so parallel Teams deliveries cannot start two turns.
    const run = { cancelled: false, session: undefined };
    this.active = run;
    run.done = this.run(text, run);
    void run.done.catch(() => console.error("Could not deliver a task result to Teams."));
  }

  async run(prompt, run) {
    try {
      await this.send(`Working in ${this.selected}. I will ask for any required permissions.`);
      if (run.cancelled) return;
      let session = this.sessions.get(this.selected);
      if (!session) {
        session = await this.client.createSession(sessionConfig({
          paths: [this.workspaces.get(this.selected)], pending: this.pending, send: this.send,
          isActive: () => Boolean(this.active) && !this.active.cancelled && !this.closing,
          instructions: "You are a devbox agent controlled through a personal Teams chat. "
              + "Work only in the selected workspace. Read its contributor instructions before edits. "
              + "Never include secrets in Teams messages. Ask before destructive operations. "
              + "Keep replies concise. Do not start detached services or make commits unless asked.",
        }));
        if (session.permissionModeResult?.mode !== "manual") {
          await session.disconnect();
          throw new Error("Runtime did not accept manual permission mode.");
        }
        this.sessions.set(this.selected, session);
      }
      run.session = session;
      if (run.cancelled) return;
      const response = await session.sendAndWait({ prompt }, this.turnTimeoutMs);
      if (!run.cancelled) {
        await this.send(response?.data.content || "Task finished without a text response.");
      }
    } catch {
      run.cancelled = true;
      this.pending.cancelAll();
      // sendAndWait timeouts do not stop the runtime; abort before accepting another turn.
      try {
        await run.session?.abort();
      } catch {
        this.closing = true;
      }
      await this.send("Task failed or timed out. Check local Copilot authentication and service logs."
        + (this.closing ? " Restart the bridge before sending another task." : ""));
    } finally {
      this.pending.cancelAll();
      this.active = undefined;
    }
  }

  async stop() {
    this.closing = true;
    this.pending.cancelAll();
    await this.authorStartDone;
    await this.author?.stop();
    if (this.active) {
      this.active.cancelled = true;
      this.pending.cancelAll();
      await this.active.session?.abort();
      await this.active.done;
    }
    await Promise.all([...this.sessions.values()].map((session) => session.disconnect()));
  }

  async controlAuthor(action, args = {}) {
    if (!this.author) throw new Error("Continuous Author is unavailable; update and restart the bridge.");
    if (action === "status") return this.authorStarting
      ? { ...this.author.status(), phase: "awaiting parent work item", reserved: true } : this.author.status();
    if (action === "stop") {
      if (this.authorStarting) {
        this.pending.cancelAll();
        await this.authorStartDone;
      }
      return this.author.stop();
    }
    if (action === "adopt") return this.author.adopt(args.alias, args.id);
    if (action !== "start") throw new Error("Unknown Author action.");
    if (this.closing || this.active || this.authorStarting) throw new Error("Another task or Author start is in progress.");
    return this.author.start(args);
  }

  async handleAuthor(args) {
    const [action, alias, id] = args;
    if (action === "start" && args.length === 1) {
      if (!this.author?.config) return this.send("Run plugin setup and configure continuous author repositories first.");
      if (this.active || this.authorStarting || this.author.busy) return this.send("Another task or Author is already running.");
      this.authorStarting = true;
      this.authorStartDone = (async () => {
        try {
          const parent = await this.pending.request("question",
            "Which ADO parent work-item URL/ID should this Author run use? Reply none to disable findings. "
              + "I ask this for every new run; a previous parent is never reused.", this.send);
          if (parent === null || this.closing) return;
          this.authorStarting = false;
          await this.controlAuthor("start", { parentWorkItem: parent });
        } catch (error) {
          await this.send(`Author did not start: ${error.message}`);
        } finally {
          this.authorStarting = false;
        }
      })();
      void this.authorStartDone.catch(() => console.error("Could not deliver Author startup status."));
      return;
    }
    try {
      if (action === "status" && args.length === 1) {
        const status = await this.controlAuthor("status");
        return this.send(JSON.stringify({ ...status, lastReport: undefined }, null, 2));
      }
      if (action === "stop" && args.length === 1) {
        await this.controlAuthor("stop");
        return this.send("Author stopped. Completed actions are not undone; spawned commands may still need attention.");
      }
      if (action === "adopt" && args.length === 3 && /^[1-9]\d*$/.test(id)) {
        await this.controlAuthor("adopt", { alias, id: Number(id) });
        return this.send(`PR ${id} in ${alias} adopted for the next fresh sweep.`);
      }
      return this.send("Use /author start, /author status, /author stop, or /author adopt <alias> <PR ID>.");
    } catch (error) {
      return this.send(`Author command failed: ${error.message}`);
    }
  }
}
