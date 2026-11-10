---
name: teams-author
description: Start, inspect, stop, or adopt PRs into the continuous multi-repository PR Author on your Teams devbox. Maintains authored/adopted PRs, review feedback, conflicts, exact-head evidence, and optional ADO findings across configured GC2, 1JS, PowerPoint, Office, or other repositories.
---

Use the plugin's `author_start`, `author_status`, `author_stop`, and `author_adopt`
MCP tools. Teams `/author` and this skill control the SAME bridge-owned runner;
do not create a second agent, schedule, detached CLI, clone, or polling loop.

For **every new start**, ask the user which ADO parent work-item URL/ID to use,
or whether to disable findings with `none`. Never reuse a previous parent's
value or infer one from repository instructions. Use the normal user-question
tool and wait for an explicit answer. With multiple ADO organizations require
a full `https://dev.azure.com/<org>/<project>/_workitems/edit/<id>` URL.
Pass the answer to `author_start` as `parentWorkItem` (`null` for explicit none).
Omit `aliases` to cover all configured repositories, or pass only explicitly
requested aliases. Status, stop, and adopt do not need a new parent.

Before starting, check `author_status`. If a runner exists, report its state
instead of creating another. To switch parents/scopes, explicitly stop it and
start again with a fresh parent question. Never silently replace a running mission.

If repositories have not been configured, use `teams-setup`. During setup the
user supplies an existing checkout or explicitly approves cloning into a new
destination for each repository, and configures their ADO identity, verified
repository mappings, normal targets, and optional path-specific ancestry rules.
Never assume GC2, 1JS, PowerPoint, or Office exists at any hardcoded path.
Azure CLI, its azure-devops extension, Git and working ADO authentication are
prerequisites. Do not silently install global tools or alter authentication.

The bridge must be running and paired with the user's personal Teams chat.
Tell the user that tool approvals, protected-action questions, and meaningful
updates arrive there, even when starting from CLI. Normal tool approvals remain
in force. The runner may edit/test/commit/push, make draft PRs, and reply to
reviews, but must ask before merging, rewriting history, or claiming work items.
Do not grant blanket shell permissions to make it more autonomous.

Report startup as **running**, not completed or healthy. It polls automatically
until stopped while the devbox/bridge remain running. Bridge shutdown stops it;
restart requires another explicit start and parent question. Never claim an
exact-head build passed or a PR is healthy merely because the runner started.
On timeout or ambiguous tool failure, check status before retrying.

For adoption ask for the configured alias and exact PR ID, then call
`author_adopt`; this adds it to the next fresh sweep, not an already completed
one. Stop with `author_stop` and state that completed changes are not undone
and already spawned commands may need attention. Do not expose tokens,
credentials, or private repository content outside the configured services.
