import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { writeFixtureTree } from "./fixture-tree.test-support.js";
import { UPDATE_PREFLIGHT_REBASE_TIMEOUT_MS } from "./update-run-timeouts.js";
import {
  createGitUpdateFixture,
  runFixtureGit as git,
  type GitUpdateFixture,
} from "./update-runner-git-candidate.test-support.js";
import type { UpdateRunResult, UpdateRunnerOptions } from "./update-runner-types.js";

const PRESERVED_REF = /refs\/openclaw\/\S+?(?=[\s.,;]|$)/u;

describe("Git update local main replay", () => {
  const directories = useAutoCleanupTempDirTracker(afterEach);
  let directory: string;
  let fixture: GitUpdateFixture;
  let root: string;
  let remote: string;
  let rebases: Array<number | undefined>;

  beforeEach(async () => {
    directory = await fs.realpath(directories.make("openclaw-git-local-replay-"));
    fixture = await createGitUpdateFixture(directory);
    ({ root, remote } = fixture);
    rebases = [];
    observeRebases();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function observeRebases() {
    const execute = fixture.runCommand;
    fixture.runCommand = (argv, options) => {
      if (isRebase(argv)) {
        rebases.push(options.timeoutMs);
      }
      return execute(argv, options);
    };
  }

  function isRebase(argv: readonly string[]) {
    return argv.includes("rebase") && !argv.includes("--abort");
  }

  function update(opts: Partial<Omit<UpdateRunnerOptions, "prepareGitExposure">> = {}) {
    fixture.stopped = false;
    return fixture.update({
      runGitDoctor: async (doctorRoot) => ({
        name: "openclaw doctor",
        command: "CLI activation doctor",
        cwd: doctorRoot,
        durationMs: 0,
        exitCode: 0,
      }),
      ...opts,
    });
  }

  async function commit(checkout: string, files: Record<string, string>, message: string) {
    await writeFixtureTree(checkout, files);
    await git(checkout, "add", ".");
    await git(checkout, "commit", "-m", message);
    return git(checkout, "rev-parse", "HEAD");
  }

  async function deployDetached(sha: string) {
    await git(root, "checkout", "--detach", sha);
    fixture.beforeSha = sha;
    await fixture.writeRuntime();
  }

  /**
   * Reproduces the observed deployment: main keeps complete history while the shallow
   * boundary above it hides that history from everything fetched since.
   */
  async function strandLocalMainBehindShallowBoundary() {
    await commit(remote, { "retired.txt": "removed upstream later\n" }, "stale upstream commit");
    await git(root, "pull", "--ff-only");
    const staleMain = await git(root, "rev-parse", "HEAD");
    await git(remote, "rm", "retired.txt");
    await git(remote, "commit", "-m", "retire file");
    const deployed = await git(remote, "rev-parse", "HEAD");
    await git(root, "fetch", "--depth=1", "origin", "main");
    await deployDetached(deployed);
    const relation = await runCommandWithTimeout(
      ["git", "-C", root, "merge-base", staleMain, deployed],
      { timeoutMs: 5000 },
    );
    expect(relation.code, "the fixture must have no local merge base").toBe(1);
    return { staleMain, deployed };
  }

  function failBuildWhenLocalWorkIsPresent() {
    const execute = fixture.runCommand;
    fixture.runCommand = async (argv, options) => {
      const breaks =
        argv[0] === "pnpm" &&
        argv[1] === "build" &&
        (await fs.stat(path.join(options.cwd!, "breaks-build.txt")).catch(() => null));
      return breaks
        ? { code: 1, stdout: "", stderr: "local work broke the build" }
        : execute(argv, options);
    };
  }

  const warningsOf = (result: UpdateRunResult) =>
    result.steps.flatMap((step) => (step.advisory ? [step.advisory.message] : []));

  async function expectPreserved(result: UpdateRunResult, sha: string) {
    const warning = warningsOf(result).find((message) => PRESERVED_REF.test(message));
    expect(warning, JSON.stringify(warningsOf(result))).toBeDefined();
    const ref = PRESERVED_REF.exec(warning!)![0];
    expect(await git(root, "rev-parse", ref)).toBe(sha);
  }

  const preservedRefs = () => git(root, "for-each-ref", "--format=%(refname)", "refs/openclaw");

  it("activates the clean target and preserves a main with no local merge base", async () => {
    const { staleMain } = await strandLocalMainBehindShallowBoundary();
    const target = await fixture.advanceRemote();

    const result = await update();

    expect(result).toMatchObject({ status: "ok", after: { sha: target } });
    expect(rebases).toEqual([]);
    expect(await git(root, "branch", "--show-current")).toBe("main");
    await expect(fs.stat(path.join(root, "retired.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expectPreserved(result, staleMain);

    // The repaired checkout converges: the next run has nothing to warn about.
    const next = await commit(remote, { "next.txt": "next\n" }, "next upstream commit");
    fixture.beforeSha = target;
    const followUp = await update();
    expect(followUp).toMatchObject({ status: "ok", after: { sha: next } });
    expect(warningsOf(followUp).filter((message) => PRESERVED_REF.test(message))).toEqual([]);
  });

  it("does not replay a main whose apparent local work exceeds the bound", async () => {
    const parent = await git(root, "rev-parse", "HEAD");
    const commits = Array.from(
      { length: 1001 },
      (_, index) =>
        `commit refs/heads/main\ncommitter Test <test@example.com> ${index} +0000\ndata 1\nx\n${
          index === 0 ? `from ${parent}\n` : ""
        }\n`,
    ).join("");
    await git(root, "checkout", "--detach", parent);
    const imported = await runCommandWithTimeout(["git", "-C", root, "fast-import", "--force"], {
      timeoutMs: 5000,
      input: commits,
    });
    expect(imported.code, imported.stderr).toBe(0);
    const localMain = await git(root, "rev-parse", "refs/heads/main");
    fixture.beforeSha = parent;
    const target = await fixture.advanceRemote();

    const result = await update();

    expect(result).toMatchObject({ status: "ok", after: { sha: target } });
    expect(rebases).toEqual([]);
    await expectPreserved(result, localMain);
  });

  it("fast-forwards a stale main that is a real ancestor without warning", async () => {
    await commit(remote, { "deployed.txt": "deployed\n" }, "deployed");
    await git(root, "fetch", "origin");
    await deployDetached(await git(root, "rev-parse", "origin/main"));
    const target = await fixture.advanceRemote();

    const result = await update();

    expect(result).toMatchObject({ status: "ok", after: { sha: target } });
    expect(await git(root, "rev-parse", "main")).toBe(target);
    expect(await preservedRefs()).toBe("");
    expect(warningsOf(result)).toEqual([]);
  });

  it.each([
    { label: "the replay deadline", timeoutMs: undefined },
    { label: "a shorter caller deadline", timeoutMs: 60_000 },
  ])("rebases real unpublished commits on main under $label", async ({ timeoutMs }) => {
    const base = await git(root, "rev-parse", "HEAD");
    await commit(root, { "local.txt": "unpublished\n" }, "unpublished work");
    await deployDetached(base);
    const target = await fixture.advanceRemote();

    const result = await update({ timeoutMs });

    expect(result.status, JSON.stringify(result.steps)).toBe("ok");
    expect(await git(root, "rev-parse", "HEAD^")).toBe(target);
    expect(await git(root, "log", "-1", "--format=%s", "main")).toBe("unpublished work");
    expect(await fs.readFile(path.join(root, "local.txt"), "utf8")).toBe("unpublished\n");
    expect(rebases).toEqual([timeoutMs ?? UPDATE_PREFLIGHT_REBASE_TIMEOUT_MS]);
    expect(await preservedRefs()).toBe("");
  });

  it("preserves main when a successful replay flattens its merge commits", async () => {
    const base = await git(root, "rev-parse", "HEAD");
    await git(root, "checkout", "-b", "side");
    await commit(root, { "side.txt": "side\n" }, "side work");
    await git(root, "checkout", "main");
    await commit(root, { "local.txt": "local\n" }, "main work");
    await git(root, "merge", "--no-ff", "--no-commit", "side");
    // This edit exists only in the merge commit, so a flattening rebase cannot carry it.
    await commit(root, { "merge-only.txt": "merge only\n" }, "merge with its own edit");
    const localMain = await git(root, "rev-parse", "HEAD");
    await deployDetached(base);
    const target = await fixture.advanceRemote();

    const result = await update();

    expect(result.status, JSON.stringify(result.steps)).toBe("ok");
    expect(await git(root, "merge-base", "--is-ancestor", target, "HEAD")).toBe("");
    await expect(fs.stat(path.join(root, "merge-only.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expectPreserved(result, localMain);
  });

  it("walks back on a conflict, then activates the clean target when none accepts main", async () => {
    const base = await git(root, "rev-parse", "HEAD");
    const localMain = await commit(root, { "shared.txt": "local\n" }, "conflicting local work");
    await deployDetached(base);
    await commit(remote, { "shared.txt": "upstream one\n" }, "upstream one");
    const target = await commit(remote, { "shared.txt": "upstream two\n" }, "upstream two");

    const result = await update();

    expect(result).toMatchObject({ status: "ok", after: { sha: target } });
    // Each candidate newer than the deployed commit gets one attempt before giving up on main.
    expect(rebases).toHaveLength(2);
    expect(await git(root, "branch", "--show-current")).toBe("main");
    await expectPreserved(result, localMain);
  });

  it.skipIf(process.platform === "win32")(
    "bounds a hung rebase once and then activates the clean target",
    async () => {
      const base = await git(root, "rev-parse", "HEAD");
      const localMain = await commit(root, { "local.txt": "unpublished\n" }, "unpublished work");
      await deployDetached(base);
      await fixture.advanceRemote();
      const target = await commit(remote, { "latest.txt": "latest\n" }, "latest");
      // A signing program that never answers hangs the real rebase without a test double.
      const hang = path.join(directory, "hang-gpg.sh");
      await fs.writeFile(hang, "#!/bin/sh\nexec sleep 30\n", { mode: 0o700 });
      await git(root, "config", "gpg.program", hang);
      await git(root, "config", "commit.gpgSign", "true");
      const execute = fixture.runCommand;
      const requested: Array<number | undefined> = [];
      fixture.runCommand = (argv, options) => {
        if (!isRebase(argv)) {
          return execute(argv, options);
        }
        requested.push(options.timeoutMs);
        return execute(argv, { ...options, timeoutMs: 1000 });
      };

      const result = await update();

      expect(result).toMatchObject({ status: "ok", after: { sha: target } });
      // No --timeout was passed: the step still has a real deadline and spends it once.
      expect(requested).toEqual([UPDATE_PREFLIGHT_REBASE_TIMEOUT_MS]);
      expect(result.steps.find((step) => step.name === "preflight-rebase")).toMatchObject({
        termination: "timeout",
      });
      await expectPreserved(result, localMain);
    },
  );

  it("stops the update when the operator interrupts the rebase", async () => {
    const base = await git(root, "rev-parse", "HEAD");
    const localMain = await commit(root, { "local.txt": "unpublished\n" }, "unpublished work");
    await deployDetached(base);
    await fixture.advanceRemote();
    await commit(remote, { "latest.txt": "latest\n" }, "latest");
    const execute = fixture.runCommand;
    let interrupted = false;
    fixture.runCommand = (argv, options) => {
      if (!isRebase(argv) || interrupted) {
        return execute(argv, options);
      }
      interrupted = true;
      return runCommandWithTimeout(
        [process.execPath, "-e", 'process.kill(process.pid, "SIGTERM"); setInterval(() => {})'],
        options,
      );
    };

    const result = await update();

    // The older candidate would rebase and build; interruption must end the attempt anyway.
    expect(result).toMatchObject({ status: "error", reason: "preflight-no-good-commit" });
    expect(rebases).toEqual([]);
    expect(fixture.events).not.toContain("build");
    expect(await git(root, "rev-parse", "HEAD")).toBe(base);
    expect(await git(root, "rev-parse", "main")).toBe(localMain);
    expect(await preservedRefs()).toBe("");
  });

  it("retries a candidate that failed validation with local commits when replay is abandoned", async () => {
    await commit(remote, { "shared.txt": "shared\n" }, "shared file");
    await git(root, "pull", "--ff-only");
    const shared = await git(root, "rev-parse", "HEAD");
    const localMain = await commit(
      root,
      { "shared.txt": "local\n", "breaks-build.txt": "local\n" },
      "local work that breaks the build",
    );
    await deployDetached(shared);
    await commit(remote, { "shared.txt": "upstream\n" }, "conflicts with local work");
    const target = await commit(remote, { "shared.txt": "shared\n" }, "accepts local work again");
    failBuildWhenLocalWorkIsPresent();

    const result = await update();

    expect(result).toMatchObject({ status: "ok", after: { sha: target } });
    expect(rebases).toHaveLength(2);
    await expectPreserved(result, localMain);
  });

  it("retries clean candidates when the walk ends on a validation failure", async () => {
    const base = await git(root, "rev-parse", "HEAD");
    const localMain = await commit(
      root,
      { "shared.txt": "local\n", "breaks-build.txt": "local\n" },
      "local work that breaks the build",
    );
    await git(root, "checkout", "--detach", base);
    // Local to this checkout, so no candidate can end the walk as already current.
    await deployDetached(await commit(root, { "deployed.txt": "deployed\n" }, "deployed only"));
    await fixture.advanceRemote();
    const target = await commit(
      remote,
      { "shared.txt": "upstream\n" },
      "conflicts with local work",
    );
    failBuildWhenLocalWorkIsPresent();

    const result = await update();

    expect(result).toMatchObject({ status: "ok", after: { sha: target } });
    expect(rebases).toHaveLength(3);
    await expectPreserved(result, localMain);
  });

  it("activates detached and leaves main alone when its commits cannot be preserved", async () => {
    const { staleMain } = await strandLocalMainBehindShallowBoundary();
    // A ref at the namespace root makes every preservation ref below it unwritable.
    await git(root, "update-ref", "refs/openclaw/update-preserved", staleMain);
    const target = await fixture.advanceRemote();

    const result = await update();

    expect(result).toMatchObject({ status: "ok", after: { sha: target } });
    expect(await git(root, "rev-parse", "HEAD")).toBe(target);
    expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(await git(root, "rev-parse", "main")).toBe(staleMain);
    expect(warningsOf(result).join("\n")).toContain(staleMain);
  });

  it("keeps the preserved commits when activation rolls back", async () => {
    const { staleMain, deployed } = await strandLocalMainBehindShallowBoundary();
    await fixture.advanceRemote();

    const result = await update({ runGitDoctor: async () => null });

    expect(result).toMatchObject({ status: "error", reason: "doctor-entry-missing" });
    expect(await git(root, "rev-parse", "HEAD")).toBe(deployed);
    await expectPreserved(result, staleMain);
  });
});
