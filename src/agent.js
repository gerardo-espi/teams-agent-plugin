import { PendingRequests } from "./pending.js";

const help = [
  "I am your devbox agent, with my own Teams bot identity.",
  "/workspaces - list configured repositories",
  "/use <alias> - select a repository",
  "/status - show current workspace and pending requests",
  "/cancel - abort the active request",
  "/reset - start a fresh conversation in this workspace",
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

  constructor({ client, workspaces, send, turnTimeoutMs = 1_800_000 }) {
    this.client = client;
    this.workspaces = workspaces;
    this.send = send;
    this.turnTimeoutMs = turnTimeoutMs;
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
        + `Running: ${Boolean(this.active)}\nPending requests: ${this.pending.items.size}`);
    }
    if (command === "/cancel") {
      if (!this.active) return this.send("Nothing is running.");
      this.active.cancelled = true;
      this.pending.cancelAll();
      await this.active.session?.abort();
      return this.send("Cancellation requested. Already completed actions are not undone.");
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
        session = await this.client.createSession({
          workingDirectory: this.workspaces.get(this.selected),
          availableTools: [
            "powershell", "read_powershell", "stop_powershell", "list_powershell",
            "glob", "grep", "view", "create", "edit", "apply_patch", "ask_user",
          ].map((name) => `builtin:${name}`),
          permissionMode: "manual",
          enableConfigDiscovery: false,
          enableFileHooks: false,
          enableManagedSettings: true,
          enableHostGitOperations: true,
          enableOnDemandInstructionDiscovery: true,
          instructionDirectories: [this.workspaces.get(this.selected)],
          systemMessage: {
            mode: "append",
            content: "You are a devbox agent controlled through a personal Teams chat. "
              + "Work only in the selected workspace. Read its contributor instructions before edits. "
              + "Never include secrets in Teams messages. Ask before destructive operations. "
              + "Keep replies concise. Do not start detached services or make commits unless asked.",
          },
          onPermissionRequest: async (request) => {
            if (!this.active || this.active.cancelled || this.closing) return { kind: "reject" };
            const details = request.fullCommandText ?? request.fileName
              ?? request.path ?? request.url ?? request.toolName ?? request.kind;
            const preview = `Permission requested (${request.kind}):\n${details}`;
            if (preview.length > 10_000) {
              return { kind: "reject", feedback: "Request too long to review safely in Teams." };
            }
            const approved = await this.pending.request("permission", preview, this.send);
            return approved === true
              ? { kind: "approve-once", approvedInteractively: true }
              : { kind: "reject", feedback: "Denied, cancelled, or approval expired." };
          },
          onUserInputRequest: async (request) => {
            if (!this.active || this.active.cancelled || this.closing) {
              throw new Error("No active task.");
            }
            const answer = await this.pending.request("question",
              [request.question, ...(request.choices ?? [])].join("\n"), this.send);
            if (answer === null) throw new Error("Question expired or was cancelled.");
            return { answer, wasFreeform: !request.choices?.includes(answer) };
          },
        });
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
    if (this.active) {
      this.active.cancelled = true;
      this.pending.cancelAll();
      await this.active.session?.abort();
      await this.active.done;
    }
    await Promise.all([...this.sessions.values()].map((session) => session.disconnect()));
  }
}
