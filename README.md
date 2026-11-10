# Teams devbox agent

A personal Teams bot with its **own name, avatar, and sender identity**. Send it
instructions for repositories on this devbox; receive replies, permission
requests, and proactive notifications as the bot, never as your Teams account.
The bot uses your local Copilot authentication to run the coding agent. A second
human Teams account is not needed.

## Install with Copilot CLI (no manual clone)

Install Git, Node.js 22.12+, GitHub Copilot CLI, Microsoft Dev Tunnels
(`winget install Microsoft.devtunnel` on Windows), and the Teams Developer CLI
(`npm install -g @microsoft/teams.cli`). Reopen your terminal after PATH changes.
The repository is public. Install the plugin and start Copilot:

```powershell
copilot plugin install gerardo-espi/teams-agent-plugin
copilot
```

Ask Copilot:

```text
Use the teams-setup skill to set up my Teams agent.
```

The bundled skill locates its own installed plugin directory and opens a
separate interactive setup terminal. Its launcher runs `npm ci` followed by
`npm run setup`, stopping if installation fails. You do not need to find the
plugin cache directory or clone a second copy. Approve the launcher when
prompted, then complete the wizard in the new terminal. Restart the original
Copilot session after dependency installation so its notification MCP server
can start. This setup launcher currently supports Windows.

For an existing installation, stop the bot/tunnel and securely back up `.env`,
`config.json`, and `.data` outside the plugin directory before updating:

```powershell
copilot plugin update teams-agent
```

Start a new Copilot session and use `teams-setup` again, keeping existing bot
credentials. Local configuration is not yet externalized from the installed
plugin directory; restore your backed-up files there before rerunning setup
if an update replaced them. Never commit or share the backup.

## Guided setup from a checkout

Alternatively, clone the public repository and run the same wizard directly:

```powershell
git clone https://github.com/gerardo-espi/teams-agent-plugin.git
Set-Location .\teams-agent-plugin
npm ci
copilot login
npm run setup
```

The interactive wizard asks for the **bot's display name**, your Entra user
Object ID, and local workspace aliases/paths. It generates a bridge token and
writes the ignored `.env` and `config.json` files. By default it also logs in to
Dev Tunnels, creates or reuses a dedicated tunnel, hosts only the bot port, and
automatically obtains its public HTTPS URL. No second terminal or URL copying
is needed. It can register a new Teams bot using your chosen name, or reuse
credentials already in `.env`.

The wizard runs `teams login`, `teams status`, and `teams app create`; tenant
permission and sideloading must be enabled. It offers to open the **Install in
Teams** page in your browser and start the bot. **Confirm Add in Teams yourself**,
then send `/help` in a personal chat. Keep the setup terminal open: it manages
both the tunnel and bridge, checks startup health, and stops its child processes
on Ctrl+C or a service failure. It does not install a background Windows service.
Sign-in prompts still require your interaction.

If you prefer an existing external tunnel, decline automatic tunnel hosting and
paste its HTTPS URL when registering. Keep that external tunnel running yourself.

Stop the previous setup/bridge before rerunning `npm run setup`. Existing credentials, tokens,
ports, optional environment settings, and workspace aliases are preserved unless
you choose to replace them. Changing the local name does not rename an existing
Teams app; rename that app in Teams Developer Portal. To run multiple devboxes
simultaneously, register a separate bot for each, rather than sharing one bot's
messaging endpoint. Managed tunnel identity is kept in `.data\tunnel.json` and
reused on subsequent runs. Setup refuses to host it if other ports have been
added. Moving an existing bot to a different endpoint requires its Teams app ID
and your explicit confirmation; this ID is different from the bot's client ID.

If registration fails after creating a remote bot, setup keeps recovery files
under `.data\setup-*` and reports the exact directory. Recover any credentials
before retrying to avoid duplicate registrations; protect and remove that specific
recovery directory when no longer needed. No credentials are sent to GitHub.
Setup does not install prerequisites, change tenant policy, silently add the
Teams app, start background services, or bypass approvals.

To update, stop the bridge and run these commands from the checkout:

```powershell
git pull --ff-only
npm ci
npm run setup
```

Accept the saved configuration, decline new-bot registration, and let setup
restart the tunnel and bot. `npm start` still starts only the bridge, for use
with a separately hosted tunnel. Restart any Copilot CLI sessions that loaded
the plugin to pick up updates.

## Manual setup on the devbox

1. Install Node.js 22.12+ and GitHub Copilot CLI. Sign in to Copilot interactively
   with `copilot login`. Keep the devbox awake while the service is needed.
2. In this directory, run:

   ```powershell
   npm ci
   Copy-Item .env.example .env
   Copy-Item config.example.json config.json
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   Put the generated value in `BRIDGE_TOKEN` in `.env`. Edit `config.json` to
   allow only the local repositories this bot should work with. Aliases, not
   arbitrary paths from Teams, select the working directory.
3. Install the Teams Developer CLI and check your tenant:

   ```powershell
   npm install -g @microsoft/teams.cli
   teams login
   teams status
   ```

   You need custom app upload (sideloading) enabled and permission to register a
   bot. If unavailable, ask your Teams administrator to enable it or provision
   the bot for you. This project does not bypass tenant policy.
4. Create a public HTTPS development tunnel to **localhost port 3978 only**.
   For Microsoft Dev Tunnels, after installing `devtunnel`:

   ```powershell
   devtunnel user login
   devtunnel create teams-devbox-agent --allow-anonymous
   devtunnel port create teams-devbox-agent -p 3978 --protocol http
   devtunnel host teams-devbox-agent
   ```

   The tunnel permits Teams to reach the endpoint; the Teams SDK still validates
   signed incoming requests. Do not expose port 3979, add the bridge token to a
   URL, or disable Teams authentication. Keep the tunnel terminal open.
5. Register a separate bot identity:

   ```powershell
   teams app create --name "Devbox Agent" --endpoint https://YOUR-TUNNEL-HOST/api/messages --env .env
   ```

   The current Teams CLI supports Teams-managed bots without an Azure
   subscription. Alternatively use an administrator-provisioned single-tenant
   Azure Bot with the Teams channel enabled. Supply its `CLIENT_ID`,
   `CLIENT_SECRET`, and `TENANT_ID` in `.env`. Confirm registration did not
   overwrite the other `.env` values. Customize the app name/avatar in Teams
   Developer Portal. Install the app using the link printed by the CLI.
6. Put **your own Microsoft Entra user object ID** in `ALLOWED_USER_ID`.
   This is the Object ID on your user profile in the Entra portal, not your
   email, the bot's client ID, or your tenant ID. Do not paste credentials into
   Teams or source control. The service refuses to start without these settings.
7. Start the bridge in a terminal:

   ```powershell
   npm start
   ```

   Open `http://127.0.0.1:3978/health` locally, then send `/help` to your bot in a
   **personal chat**. That first authenticated message persists the conversation
   reference, including its full service URL, for later proactive messages.

## Give instructions in Teams

```text
/workspaces
/use gc2
Explain the current git diff.
Update the relevant test for this behavior.
/status
/approve <the ID from a permission request>
/answer <the ID from a question> <your answer>
/cancel
/reset
```

Only the configured user in the configured tenant can give instructions. Group
chats and channels are rejected. Only one task runs at a time; control commands
and approval replies remain available while it runs. Permission requests expire
after two minutes and are denied unless explicitly approved once. Tasks time out
after 30 minutes and are aborted. `/cancel` does not undo actions already taken
or guarantee termination of processes a command already launched.

Each workspace has a separate Copilot conversation for this process's lifetime.
Restarting the bridge preserves the Teams notification destination but starts
fresh agent conversations and requires `/use` again. Notifications are delivered
only while the bridge is running; there is no offline queue or automatic retry.
Teams retry deduplication is in memory (24 hours, up to 10,000 activity IDs), not
durable across restarts. Review work after an interrupted task before reissuing it.

## Use the Copilot CLI notification plugin

With Node on PATH, load the plugin from any local workspace:

```powershell
copilot --plugin-dir C:\Users\gerardomar\dev\teams-agent-plugin
```

Ask Copilot to "use teams-notify to tell me when this task is finished." Its MCP
`notify` tool calls the loopback-only notification service using `BRIDGE_TOKEN`
from this plugin's `.env`. The bot must already be running and paired.
This adds a notification tool to that CLI session; it does not remotely attach
Teams to an existing interactive CLI conversation. Teams runs its own sessions.
`BRIDGE_TOKEN` and `NOTIFY_PORT` environment variables can override the MCP
process's `.env` values.

## Trust boundary

The Teams SDK authenticates inbound bot traffic; the bridge additionally checks
tenant, user, recipient bot, and personal-chat scope. Replies use bot credentials,
not delegated Graph `ChatMessage.Send` as you. Bot credentials are removed from
the Copilot child process environment.

**A workspace list and permission prompts are not an OS sandbox.** An approved
shell command runs as the devbox account and may access resources beyond the
selected repository. Use a dedicated least-privilege devbox/account, review
requested commands carefully, and do not point this agent at untrusted repos.
Copilot still applies its managed organization policies. Repository instructions
are enabled, but automatic repository hooks, plugins, and MCP discovery are
disabled in the Teams-controlled sessions.

Restrict Windows file ACLs on `.env`, `config.json`, `.data`, and Copilot session
storage to the devbox account and administrators. POSIX file modes do not enforce
Windows ACLs. The loopback token authenticates callers but is not isolation from
other local users able to read those files. Transcripts persist in Copilot's
local session storage; Teams retains messages under your organization's policy.
Pairing is locked to the first authorized personal conversation; to re-pair,
stop the service and delete only `.data\conversation.json`.

This version supports the public Microsoft cloud. Sovereign clouds require
explicit endpoint/authentication changes. No service is auto-started or scheduled.

## Development

```powershell
npm test
npm run check
```

References:
[Teams setup](https://microsoft.github.io/teams-sdk/typescript/getting-started/running-in-teams/),
[proactive messages](https://microsoft.github.io/teams-sdk/typescript/essentials/sending-messages/proactive-messaging/),
[Copilot SDK](https://github.com/github/copilot-sdk),
[CLI plugins](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference).
