---
name: teams-notify
description: Send the user a progress update or completion notification through their separate Teams bot identity.
---

Use the teams-agent MCP tool `notify` to send a message to the user's configured
personal Teams bot conversation. Only send updates the user requested. Never
include secrets, credentials, or raw file contents. A successful tool call means
Teams accepted the message, not that the user read it.

The bridge must be running and the user must have sent the bot a message first.
If the tool fails, report that failure; do not fall back to messaging as the user.
