import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";

const ref = z.string().regex(/^refs\/heads\/[a-z0-9][a-z0-9._/-]*$/i).refine((value) =>
  !value.includes("..") && !value.includes("//") && !value.endsWith("/")
  && value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock")));
const repository = z.object({
  organization: z.string().url(),
  project: z.string().min(1),
  repository: z.string().min(1),
  repositoryId: z.string().uuid(),
  targetRef: ref,
  rules: z.array(z.object({
    pathPrefix: z.string().regex(/^(?![./\\])(?!.*\.\.)[^\\]+\/$/),
    targetRef: ref,
    isolatedHistory: z.boolean(),
  })).max(20),
});
const authorSchema = z.object({
  engineer: z.string().min(1).max(200).regex(/^[^\s]+@[^\s]+$|^[0-9a-f-]{36}$/i),
  pollIntervalMs: z.number().int().min(60_000).max(3_600_000),
  repositories: z.record(z.string(), repository),
});

export function azureRepository(value) {
  const ssh = /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(value);
  if (ssh) {
    return { organization: `https://dev.azure.com/${ssh[1]}`, project: decodeURIComponent(ssh[2]),
      repository: decodeURIComponent(ssh[3]).replace(/\.git$/, "") };
  }
  const url = new URL(value);
  if (!["https:", "ssh:"].includes(url.protocol) || url.password || url.search || url.hash || url.port) {
    throw new Error("Use an Azure DevOps HTTPS or SSH repository URL without credentials or query parameters.");
  }
  let parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  let organization;
  if (url.protocol === "https:" && url.hostname === "dev.azure.com") {
    organization = parts.shift();
  } else if (url.protocol === "https:" && /^[a-z0-9-]+\.visualstudio\.com$/i.test(url.hostname)) {
    organization = url.hostname.split(".")[0];
    if (parts[0] === "DefaultCollection") parts.shift();
  } else if (url.protocol === "ssh:" && url.hostname === "ssh.dev.azure.com" && parts.shift() === "v3") {
    organization = parts.shift();
    parts.splice(1, 0, "_git");
  }
  if (!organization || parts.length !== 3 || parts[1] !== "_git" || parts.some((part) => !part)) {
    throw new Error("Use the full Azure DevOps repository clone URL.");
  }
  return {
    organization: `https://dev.azure.com/${encodeURIComponent(organization)}`,
    project: parts[0], repository: parts[2].replace(/\.git$/, ""),
  };
}

export function validateAuthorConfig(value, workspaces) {
  if (value === undefined) return undefined;
  const config = authorSchema.parse(value);
  const aliases = Object.keys(config.repositories);
  if (!aliases.length || aliases.some((alias) => !workspaces.has(alias))) {
    throw new Error("Author repositories must refer to configured workspace aliases.");
  }
  const paths = aliases.map((alias) => workspaces.get(alias).toLowerCase());
  if (new Set(paths).size !== paths.length) throw new Error("Each author repository needs a distinct checkout.");
  const identities = Object.values(config.repositories).map((repo) => `${repo.organization}/${repo.repositoryId}`.toLowerCase());
  if (new Set(identities).size !== identities.length) throw new Error("Configure only one checkout per author repository.");
  for (const repo of Object.values(config.repositories)) {
    if (!/^https:\/\/dev\.azure\.com\/[a-z0-9-]+$/i.test(repo.organization)) {
      throw new Error("Author organization must be https://dev.azure.com/<organization>.");
    }
  }
  return config;
}

export function parentWorkItem(value, repositories) {
  if (value === null || (typeof value === "string" && /^(none|no)$/i.test(value.trim()))) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Ask for a parent work-item URL/ID on every start, or explicitly choose none.");
  }
  value = value.trim();
  const organizations = new Set(repositories.map((repo) => repo.organization.toLowerCase()));
  let organization;
  let id;
  if (/^[1-9]\d*$/.test(value) && organizations.size === 1) {
    [organization] = organizations;
    id = Number(value);
  } else {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port) {
      throw new Error("Use an Azure DevOps work-item URL without credentials or query parameters.");
    }
    if (url.hostname === "dev.azure.com") {
      const match = /^\/([^/]+)\/[^/]+\/_workitems\/edit\/([1-9]\d*)\/?$/.exec(url.pathname);
      if (!match) throw new Error("Use a full Azure DevOps work-item URL.");
      organization = `https://dev.azure.com/${match[1]}`.toLowerCase();
      id = Number(match[2]);
    } else {
      const match = /^\/(?:DefaultCollection\/)?[^/]+\/_workitems\/edit\/([1-9]\d*)\/?$/.exec(url.pathname);
      if (!/^[a-z0-9-]+\.visualstudio\.com$/i.test(url.hostname) || !match) {
        throw new Error("Use a full Azure DevOps work-item URL.");
      }
      organization = `https://dev.azure.com/${url.hostname.split(".")[0]}`;
      id = Number(match[1]);
    }
  }
  if (!organizations.has(organization) || !Number.isSafeInteger(id) || id > 2_147_483_647) {
    throw new Error("The parent must belong to a configured organization; use its full URL when organizations differ.");
  }
  return { organization, id };
}

export async function workspaceDirectory({ prompt, yes, run }) {
  const directory = await prompt("Absolute workspace directory (existing checkout or NEW clone destination)", "",
    async (value) => {
      if (!isAbsolute(value)) return false;
      try { return (await stat(value)).isDirectory(); }
      catch (error) { return error.code === "ENOENT"; }
    });
  let exists = true;
  try { await stat(directory); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    exists = false;
  }
  if (!exists) {
    const remote = await prompt("Repository clone URL (HTTPS or SSH, no passwords)", "", (value) => {
      if (/^git@[a-z0-9.-]+:[^\s]+$/i.test(value)) return true;
      const url = new URL(value);
      const organizationUsername = url.hostname === "dev.azure.com"
        && url.username === url.pathname.split("/")[1];
      return ["https:", "ssh:"].includes(url.protocol) && !url.password
        && (url.protocol === "ssh:" || !url.username || organizationUsername) && !url.search && !url.hash;
    });
    if (!await yes("Clone this repository into the new directory?", false)) throw new Error("Clone cancelled.");
    await run("git", ["clone", "--", remote, directory]);
  }
  return realpath(directory);
}

export async function setupAuthor({ config, prompt, yes, run, log }) {
  if (!await yes("Enable continuous PR author commands?", Boolean(config.author))) {
    delete config.author;
    return;
  }
  log("Author requires Azure CLI with the azure-devops extension and your own authenticated ADO identity.");
  await run("az", ["extension", "show", "--name", "azure-devops", "--output", "none"]);
  const engineer = await prompt("Engineer ADO email or identity UUID", config.author?.engineer ?? "",
    (value) => authorSchema.shape.engineer.safeParse(value).success);
  const repositories = {};
  for (const [alias, directory] of Object.entries(config.workspaces)) {
    const canonical = await realpath(directory);
    const top = (await run("git", ["-C", directory, "rev-parse", "--show-toplevel"], { capture: true })).trim();
    if ((await realpath(top)).toLowerCase() !== canonical.toLowerCase()) {
      throw new Error(`Use the actual Git checkout root for workspace ${alias}.`);
    }
    config.workspaces[alias] = canonical;
    const remote = (await run("git", ["-C", directory, "remote", "get-url", "origin"], { capture: true })).trim();
    const location = azureRepository(remote);
    const live = JSON.parse(await run("az", ["repos", "show", "--repository", location.repository,
      "--project", location.project, "--organization", location.organization, "--output", "json"], { capture: true }));
    if (!z.string().uuid().safeParse(live.id).success) throw new Error(`Could not resolve repository identity for ${alias}.`);
    const saved = config.author?.repositories?.[alias];
    const previous = saved?.repositoryId.toLowerCase() === live.id.toLowerCase()
      && saved.organization.toLowerCase() === location.organization.toLowerCase() ? saved : undefined;
    const targetRef = "refs/heads/" + await prompt(`Normal target branch for ${alias}`,
      (previous?.targetRef ?? live.defaultBranch ?? "refs/heads/main").replace(/^refs\/heads\//, ""),
      (value) => ref.safeParse(`refs/heads/${value}`).success);
    const rules = previous?.rules ? [...previous.rules] : [];
    while (await yes(`Add a path-specific target/isolated-history rule for ${alias}?`, false)) {
      const pathPrefix = await prompt("Changed-path directory prefix (for example component/)", "",
        (value) => repository.shape.rules.element.shape.pathPrefix.safeParse(value).success);
      const target = await prompt("Required target branch", "", (value) => ref.safeParse(`refs/heads/${value}`).success);
      rules.push({ pathPrefix, targetRef: `refs/heads/${target}`,
        isolatedHistory: await yes("Require isolated source ancestry from that target?", true) });
      if (rules.length >= 20) break;
    }
    repositories[alias] = { ...location, repositoryId: live.id, targetRef, rules };
  }
  config.author = { engineer, pollIntervalMs: config.author?.pollIntervalMs ?? 300_000, repositories };
  validateAuthorConfig(config.author, new Map(Object.entries(config.workspaces)));
}
