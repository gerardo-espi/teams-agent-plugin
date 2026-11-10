export function sessionConfig({ paths, pending, send, isActive, instructions }) {
  return {
    workingDirectory: paths[0],
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
    instructionDirectories: paths,
    systemMessage: { mode: "append", content: instructions },
    onPermissionRequest: async (request) => {
      if (!isActive()) return { kind: "reject" };
      const details = request.fullCommandText ?? request.fileName
        ?? request.path ?? request.url ?? request.toolName ?? request.kind;
      const preview = `Permission requested (${request.kind}):\n${details}`;
      if (preview.length > 10_000) {
        return { kind: "reject", feedback: "Request too long to review safely in Teams." };
      }
      const approved = await pending.request("permission", preview, send);
      return approved === true && isActive()
        ? { kind: "approve-once", approvedInteractively: true }
        : { kind: "reject", feedback: "Denied, cancelled, or approval expired." };
    },
    onUserInputRequest: async (request) => {
      if (!isActive()) throw new Error("No active task.");
      const answer = await pending.request("question",
        [request.question, ...(request.choices ?? [])].join("\n"), send);
      if (answer === null || !isActive()) throw new Error("Question expired or was cancelled.");
      return { answer, wasFreeform: !request.choices?.includes(answer) };
    },
  };
}
