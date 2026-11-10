---
name: teams-setup
description: Set up the Teams devbox agent after installing the teams-agent plugin. Use when asked to set up this plugin, install its npm dependencies, run its setup wizard, or restart its bot and tunnel.
---

Run the bundled setup launcher for this plugin. Do not clone another checkout
or guess the Copilot plugin cache path.

1. Locate `setup.cmd` alongside this skill's own `SKILL.md`, using the absolute
   skill location provided when this skill was loaded. The plugin root is two
   directories above the skill directory. Read the launcher before executing it
   and confirm that root contains `plugin.json`, `package-lock.json`, and
   `src\setup.js`. Never run it in the user's current repository by mistake.
2. This launcher supports Windows. Check for Node.js 22.12+, `npm.cmd`, Copilot
   CLI, `devtunnel`, and the Teams Developer CLI (`teams`) on PATH. If anything
   is missing, report the prerequisite and its installation instructions from
   the bundled README; do not silently install global software or change policy.
   If a previous bot/setup terminal is running, have the user stop it before
   replacing dependencies. Never kill unrelated processes.
3. Open a visible, independent interactive terminal. The wizard needs a real
   TTY for the bot name, workspace paths, sign-ins, and confirmations; do not
   pipe answers or run it in a captured, non-interactive tool session. With
   `$skillDirectory` set to this skill's resolved absolute directory:

   ```powershell
   $launcher = Join-Path $skillDirectory 'setup.cmd'
   $pluginRoot = (Resolve-Path -LiteralPath (Join-Path $skillDirectory '..\..')).Path
   $window = Start-Process -FilePath $env:ComSpec `
     -ArgumentList @('/d', '/s', '/k', ('""{0}""' -f $launcher)) `
     -WorkingDirectory $pluginRoot -PassThru
   Get-Process -Id $window.Id -ErrorAction Stop | Select-Object Id, ProcessName
   ```

   Use the execution tool's detached/persistent mode if required for a terminal
   that must outlive the assistant turn. Keep normal tool approval prompts;
   never add blanket tool permissions or bypass a blocked launch.
4. The launcher runs `npm ci` and then `npm run setup` from the plugin root,
   stopping on dependency-install failure. It does not overwrite existing
   `.env` or `config.json` itself. The existing wizard asks for the bot's name,
   configures a dedicated tunnel and Teams registration, offers to open the
   install page, and can start the bridge and tunnel together.
5. Tell the user the setup terminal was opened, not that registration or setup
   has finished. They must complete sign-ins, confirm **Add** in Teams, and keep
   that terminal open while the bot runs. Ctrl+C stops the managed bot and
   tunnel. After installing dependencies, restart this Copilot session so its
   notification MCP server can start successfully.

Do not read, print, or request bot secrets or bridge tokens in chat. Do not
automatically approve agent actions or bypass Teams tenant policy. Local
configuration currently lives in the installed plugin directory: before
updating/uninstalling the plugin, stop its services and have the user securely
back up `.env`, `config.json`, and `.data` outside the plugin directory. Never
include those files in source control or tool output.
