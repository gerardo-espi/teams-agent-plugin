import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("Windows skill launcher uses its own plugin root, orders npm commands, and propagates failures",
  { skip: process.platform !== "win32" }, async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), "teams-skill-"));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const root = join(temporary, "installed plugin & spaces");
    const skill = join(root, "skills", "teams-setup");
    const tools = join(temporary, "tools");
    await mkdir(skill, { recursive: true });
    await mkdir(tools);
    const launcher = join(skill, "setup.cmd");
    await copyFile(new URL("../skills/teams-setup/setup.cmd", import.meta.url), launcher);
    const npm = join(tools, "npm.cmd");
    const log = join(temporary, "commands.log");
    const settings = join(root, ".env");
    await writeFile(settings, "TEST_ONLY=preserve-existing-settings\n");

    for (const [ciExit, setupExit] of [[0, 0], [3, 0], [0, 5]]) {
      await writeFile(log, "");
      await writeFile(npm, `@echo off\r\n`
        + `>>"%TEAMS_TEST_LOG%" echo %*\r\n`
        + `>>"%TEAMS_TEST_LOG%" cd\r\n`
        + `if "%1"=="ci" exit /b ${ciExit}\r\nexit /b ${setupExit}\r\n`);
      const child = spawn(process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", `""${launcher}""`], {
          cwd: temporary,
          windowsVerbatimArguments: true,
          env: { ...process.env, PATH: tools + ";" + process.env.PATH, TEAMS_TEST_LOG: log },
          stdio: "pipe",
        });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      assert.equal(code, ciExit || setupExit, output);
      const calls = (await readFile(log, "utf8")).trim().split(/\r?\n/);
      assert.deepEqual(calls, ciExit ? ["ci", root] : ["ci", root, "run setup", root]);
      assert.equal(await readFile(settings, "utf8"), "TEST_ONLY=preserve-existing-settings\n");
    }
  });
