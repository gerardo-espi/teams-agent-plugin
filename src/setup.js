import spawn from "cross-spawn";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { loadConfig } from "./config.js";
import { checkLocalPorts, hostTunnel, runBridge } from "./setup-runtime.js";
import { setupAuthor, workspaceDirectory } from "./author-config.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function optionalFile(path, fallback) {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function envText(values) {
  return Object.entries(values).map(([key, value]) => {
    for (const encoded of [value, `'${value}'`, `"${value}"`]) {
      if (parseEnv(`${key}=${encoded}\n`)[key] === value) return `${key}=${encoded}`;
    }
    throw new Error(`Cannot safely encode ${key} in .env. Keep its original credentials elsewhere.`);
  }).join("\n") + "\n";
}

export function messagingEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || !["/", "/api/messages"].includes(url.pathname)) {
    throw new Error("Use the public HTTPS tunnel URL, optionally ending in /api/messages.");
  }
  return `${url.origin}/api/messages`;
}

export async function runCommand(command, args, { capture = false, signal } = {}) {
  const child = spawn(command, args, { stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", signal });
  let output = "";
  if (capture) child.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
    if (output.length > 1_048_576) child.kill();
  });
  await new Promise((resolveCommand, reject) => {
    child.once("error", () => reject(new Error(`Could not start ${command}. Install it and add it to PATH.`)));
    child.once("exit", (code) => {
      if (code === 0) resolveCommand();
      else reject(new Error(`${command} did not complete successfully. Check its output and prerequisites.`));
    });
  });
  return output;
}

function jsonOutput(text, command) {
  try { return JSON.parse(text); }
  catch { throw new Error(`${command} did not return valid JSON. Update the CLI and retry.`); }
}

function installUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || !["teams.microsoft.com", "teams.cloud.microsoft"].includes(url.hostname)
    || !url.pathname.startsWith("/l/app/")) throw new Error("Unexpected Teams install link.");
  return url.href;
}

export async function managedTunnel({ root, env, run, log, signal, host = hostTunnel, checkPorts = checkLocalPorts }) {
  await checkPorts([env.PORT, env.NOTIFY_PORT]);
  await run("devtunnel", ["--version"]);
  await run("devtunnel", ["user", "login"]);
  const statePath = join(root, ".data", "tunnel.json");
  let state = jsonOutput(await optionalFile(statePath, "null"), "Tunnel state");
  if (!state) {
    const id = `teams-agent-${randomBytes(6).toString("hex")}`;
    log(`Creating dedicated tunnel ${id}. It will expose only bot port ${env.PORT}.`);
    await run("devtunnel", ["create", id, "--allow-anonymous"]);
    await run("devtunnel", ["port", "create", id, "-p", env.PORT, "--protocol", "http"]);
    state = { id, port: Number(env.PORT) };
    await writeFile(statePath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  }
  if (!/^[a-z0-9.-]+$/i.test(state.id ?? "") || state.port !== Number(env.PORT)) {
    throw new Error("Saved tunnel does not match PORT. Restore its port or provision a separate tunnel using manual setup.");
  }
  const details = jsonOutput(await run("devtunnel", ["show", state.id, "--json"], { capture: true }), "devtunnel show");
  if (!Array.isArray(details.ports) || details.ports.length !== 1
    || details.ports[0].portNumber !== Number(env.PORT) || details.ports[0].protocol !== "http") {
    throw new Error("Refusing to host a tunnel with unexpected ports. It must expose only the configured bot port over HTTP.");
  }
  const tunnel = await host({ id: state.id, port: env.PORT, signal });
  log(`Tunnel ready: ${tunnel.endpoint}`);
  return tunnel;
}

export async function runSetup({ root, ask, log = console.log, run = runCommand,
  startTunnel = managedTunnel, startBot = runBridge, signal }) {
  const env = parseEnv(await optionalFile(join(root, ".env"), ""));
  const config = JSON.parse(await optionalFile(join(root, "config.json"), "{}"));
  const prompt = async (label, fallback = "", validate = () => true) => {
    while (true) {
      const answer = (await ask(`${label}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback;
      try {
        if (await validate(answer)) return answer;
      } catch {
        // Invalid answers are retried without printing paths or credentials.
      }
      log(`Invalid ${label.toLowerCase()}. Please try again.`);
    }
  };
  const yes = async (label, defaultYes) => {
    const answer = await prompt(label, defaultYes ? "y" : "n", (value) => /^(y|yes|n|no)$/i.test(value));
    return /^y/i.test(answer);
  };

  log("Teams agent setup. Stop any running bridge before changing its settings.");
  config.botName = await prompt("Bot display name", config.botName ?? "Devbox Agent",
    (value) => value.length > 0 && value.length <= 30 && !/[\r\n]/.test(value));
  log("Use your own Entra user Object ID, not your email, tenant ID, or bot ID.");
  env.ALLOWED_USER_ID = await prompt("Allowed user Object ID", env.ALLOWED_USER_ID, (value) => uuid.test(value));

  const existing = Object.entries(config.workspaces ?? {});
  const keep = existing.length && await yes(`Keep existing workspace aliases (${existing.map(([name]) => name).join(", ")})?`, true);
  const workspaces = keep ? { ...config.workspaces } : {};
  do {
    if (Object.keys(workspaces).length && !await yes("Add another workspace?", false)) break;
    const alias = await prompt("Workspace alias", "", (value) => /^[a-z0-9-]+$/.test(value)
      && !Object.hasOwn(workspaces, value));
    workspaces[alias] = await workspaceDirectory({ prompt, yes, run });
  } while (true);
  config.workspaces = workspaces;
  await setupAuthor({ config, prompt, yes, run, log });
  env.BRIDGE_TOKEN ||= randomBytes(32).toString("hex");
  env.PORT ||= "3978";
  env.NOTIFY_PORT ||= "3979";

  const hasCredentials = uuid.test(env.CLIENT_ID ?? "") && uuid.test(env.TENANT_ID ?? "")
    && Boolean(env.CLIENT_SECRET?.trim());
  log(`The tunnel must forward localhost:${env.PORT} only. Never expose notification port ${env.NOTIFY_PORT}.`);
  log("Install @microsoft/teams.cli and devtunnel first. Setup can host the tunnel and run the bot in this terminal.");
  const register = await yes("Register a NEW Teams bot now?", !hasCredentials);
  if (!register && !hasCredentials) {
    throw new Error("Existing bot credentials are missing. Add CLIENT_ID, CLIENT_SECRET and TENANT_ID to .env, then rerun setup.");
  }
  const automatic = await yes("Create or reuse a dedicated Dev Tunnel and host it automatically?", true);
  if (register && !automatic) {
    config.endpoint = await prompt("Public HTTPS tunnel URL", config.endpoint, (value) => Boolean(messagingEndpoint(value)));
    config.endpoint = messagingEndpoint(config.endpoint);
  } else if (!register) {
    log("Keeping existing bot credentials. A local name change does not rename an existing Teams app; use Teams Developer Portal.");
  }

  await mkdir(join(root, ".data"), { recursive: true });
  const temporary = await mkdtemp(join(root, ".data", "setup-"));
  let registrationAttempted = false;
  let saved = false;
  let tunnel;
  try {
    await writeFile(join(temporary, "config.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    // Validate local settings before creating any remote resources.
    await loadConfig(pathToFileURL(temporary + sep), {
      ...env,
      CLIENT_ID: hasCredentials ? env.CLIENT_ID : "00000000-0000-0000-0000-000000000000",
      TENANT_ID: hasCredentials ? env.TENANT_ID : "00000000-0000-0000-0000-000000000000",
      CLIENT_SECRET: env.CLIENT_SECRET || "setup-validation",
    });
    if (automatic) {
      tunnel = await startTunnel({ root, env, run, log, signal });
      if (!register && config.endpoint !== tunnel.endpoint) {
        config.teamsAppId = await prompt("Existing Teams app ID (find it with teams app list)",
          config.teamsAppId, (value) => uuid.test(value));
        if (!await yes("Move this bot's endpoint to this devbox (stop its old host first)?", false)) {
          throw new Error("Existing endpoint was not changed. Register a separate bot or use manual tunnel setup.");
        }
      }
    }
    if (register || automatic) {
      await run("teams", ["login"]);
      await run("teams", ["status"]);
    }
    if (tunnel?.stopped) throw new Error("The tunnel stopped during setup. Rerun setup to reconnect.");
    if (register) {
      log("Registration requires tenant permission and sideloading enabled.");
      const credentialsPath = join(temporary, ".env");
      registrationAttempted = true;
      const output = await run("teams", ["app", "create", "--name", config.botName,
        "--endpoint", tunnel?.endpoint ?? config.endpoint, "--env", credentialsPath, "--teams-managed", "--json"],
      { capture: true });
      await writeFile(join(temporary, "registration.json"), output, { mode: 0o600 });
      const credentials = parseEnv(await readFile(credentialsPath, "utf8"));
      for (const key of ["CLIENT_ID", "CLIENT_SECRET", "TENANT_ID"]) env[key] = credentials[key] ?? "";
      await loadConfig(pathToFileURL(temporary + sep), env);
      const created = jsonOutput(output, "teams app create");
      if (!uuid.test(created.teamsAppId ?? "")) throw new Error("Registration did not return a Teams app ID.");
      config.teamsAppId = created.teamsAppId;
      config.installLink = installUrl(created.installLink);
    } else if (tunnel && config.endpoint !== tunnel.endpoint) {
      await run("teams", ["app", "update", config.teamsAppId, "--endpoint", tunnel.endpoint]);
    }
    if (tunnel) config.endpoint = tunnel.endpoint;
    if (!register && automatic && !config.installLink) {
      config.teamsAppId ||= await prompt("Existing Teams app ID (find it with teams app list)", "", (value) => uuid.test(value));
      config.installLink = installUrl((await run("teams",
        ["app", "get", config.teamsAppId, "--install-link"], { capture: true })).trim());
    }
    await writeFile(join(root, ".env"), envText(env), { mode: 0o600 });
    await writeFile(join(root, "config.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    saved = true;
    log(`Configured "${config.botName}". Protect .env, config.json and .data with Windows ACLs.`);
    if (config.installLink) {
      const link = installUrl(config.installLink);
      log(`Install in Teams: ${link}`);
      if (await yes("Open the Teams install page in your browser?", true)) {
        const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
        await run(command, process.platform === "win32" ? ["url.dll,FileProtocolHandler", link] : [link]);
      }
    }
    log("Confirm Add in Teams yourself. The bot only accepts your authorized personal chat.");
    if (await yes("Start the bot now (keep this terminal open)?", true)) {
      await startBot({ root, env, tunnel, signal, log });
    } else {
      log("Run npm run setup again to host the managed tunnel and bot together. npm start runs only the bridge.");
    }
  } catch (error) {
    if (registrationAttempted && !saved) {
      log(`Registration may have created a bot, but setup failed. Recovery files are retained in ${temporary}; protect this directory and recover any credentials before retrying.`);
    }
    throw error;
  } finally {
    await tunnel?.stop();
    // Retain credentials if a newly registered remote bot could not be saved locally.
    if (!registrationAttempted || saved) {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Run npm run setup in an interactive terminal.");
    process.exitCode = 1;
  } else {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    terminal.on("SIGINT", cancel);
    terminal.on("close", cancel);
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    const withoutInput = async (operation) => {
      const wasRaw = process.stdin.isRaw;
      terminal.pause();
      process.stdin.setRawMode?.(false);
      try { return await operation(); }
      finally {
        if (!controller.signal.aborted) {
          process.stdin.setRawMode?.(wasRaw);
          terminal.resume();
        }
      }
    };
    try {
      await runSetup({
        root: fileURLToPath(new URL("../", import.meta.url)),
        ask: (question) => terminal.question(question, { signal: controller.signal }),
        run: (command, args, options) => withoutInput(() => runCommand(command, args, { ...options, signal: controller.signal })),
        startBot: (options) => withoutInput(() => runBridge(options)),
        signal: controller.signal,
      });
    } catch (error) {
      console.error(controller.signal.aborted ? "Setup stopped." : `Setup failed: ${error.message}`);
      process.exitCode = controller.signal.aborted ? 130 : 1;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
      terminal.close();
    }
  }
}
