import spawn from "cross-spawn";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { loadConfig } from "./config.js";

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

export async function runCommand(command, args) {
  const child = spawn(command, args, { stdio: "inherit" });
  await new Promise((resolveCommand, reject) => {
    child.once("error", () => reject(new Error(`Could not start ${command}. Install it and add it to PATH.`)));
    child.once("exit", (code) => {
      if (code === 0) resolveCommand();
      else reject(new Error(`${command} did not complete successfully. Check its output and prerequisites.`));
    });
  });
}

export async function runSetup({ root, ask, log = console.log, run = runCommand }) {
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
    const directory = await prompt("Absolute workspace directory", "", async (value) =>
      isAbsolute(value) && (await stat(value)).isDirectory());
    workspaces[alias] = await realpath(directory);
  } while (true);
  config.workspaces = workspaces;
  env.BRIDGE_TOKEN ||= randomBytes(32).toString("hex");
  env.PORT ||= "3978";
  env.NOTIFY_PORT ||= "3979";

  const hasCredentials = uuid.test(env.CLIENT_ID ?? "") && uuid.test(env.TENANT_ID ?? "")
    && Boolean(env.CLIENT_SECRET?.trim());
  log(`The tunnel must forward localhost:${env.PORT} only. Never expose notification port ${env.NOTIFY_PORT}.`);
  log("For a new bot, install @microsoft/teams.cli and start an HTTPS tunnel first (see README).");
  const register = await yes("Register a NEW Teams bot now?", !hasCredentials);
  if (!register && !hasCredentials) {
    throw new Error("Existing bot credentials are missing. Add CLIENT_ID, CLIENT_SECRET and TENANT_ID to .env, then rerun setup.");
  }
  if (register) {
    config.endpoint = await prompt("Public HTTPS tunnel URL", config.endpoint, (value) => Boolean(messagingEndpoint(value)));
    config.endpoint = messagingEndpoint(config.endpoint);
  } else {
    log("Keeping existing bot credentials. A local name change does not rename an existing Teams app; use Teams Developer Portal.");
  }

  await mkdir(join(root, ".data"), { recursive: true });
  const temporary = await mkdtemp(join(root, ".data", "setup-"));
  let registrationAttempted = false;
  let saved = false;
  try {
    await writeFile(join(temporary, "config.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    // Validate local settings before creating any remote resources.
    await loadConfig(pathToFileURL(temporary + sep), {
      ...env,
      CLIENT_ID: hasCredentials ? env.CLIENT_ID : "00000000-0000-0000-0000-000000000000",
      TENANT_ID: hasCredentials ? env.TENANT_ID : "00000000-0000-0000-0000-000000000000",
      CLIENT_SECRET: env.CLIENT_SECRET || "setup-validation",
    });
    if (register) {
      await run("teams", ["login"]);
      await run("teams", ["status"]);
      log("Registration requires tenant permission and sideloading enabled.");
      const credentialsPath = join(temporary, ".env");
      registrationAttempted = true;
      await run("teams", ["app", "create", "--name", config.botName,
        "--endpoint", config.endpoint, "--env", credentialsPath]);
      const credentials = parseEnv(await readFile(credentialsPath, "utf8"));
      for (const key of ["CLIENT_ID", "CLIENT_SECRET", "TENANT_ID"]) env[key] = credentials[key] ?? "";
      await loadConfig(pathToFileURL(temporary + sep), env);
    }
    await writeFile(join(root, ".env"), envText(env), { mode: 0o600 });
    await writeFile(join(root, "config.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    saved = true;
  } catch (error) {
    if (registrationAttempted) {
      log(`Registration may have created a bot, but setup failed. Recovery files are retained in ${temporary}; protect this directory and recover any credentials before retrying.`);
    }
    throw error;
  } finally {
    // Retain credentials if a newly registered remote bot could not be saved locally.
    if (!registrationAttempted || saved) {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  log(`Configured "${config.botName}". Protect .env, config.json and .data with Windows ACLs.`);
  log("Sign in with copilot login, keep your tunnel running, then run npm start.");
  log("Install the bot using the Teams CLI's Install in Teams link, then send /help in a personal chat.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Run npm run setup in an interactive terminal.");
    process.exitCode = 1;
  } else {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    terminal.on("SIGINT", () => terminal.close());
    try {
      await runSetup({
        root: fileURLToPath(new URL("../", import.meta.url)),
        ask: (question) => terminal.question(question),
      });
    } catch (error) {
      console.error(`Setup failed: ${error.message}`);
      process.exitCode = 1;
    } finally {
      terminal.close();
    }
  }
}
