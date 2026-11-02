import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireFileLock, type FileLockHandle } from "@openclaw/fs-safe/file-lock";
import { root as openLockRoot } from "@openclaw/fs-safe/root";
import {
  DIST_ARTIFACT_LOCK_DIR_ENV,
  hasUnjoinedWork,
  inspectManagedProcessGroup,
} from "./managed-child-process.mts";
import { isRecord } from "./record-shared.mjs";
import { findRepoRoot } from "./repo-root.mjs";
import type { WithDistArtifactOwnership } from "./runtime-artifact-contract.js";

const DIST_ARTIFACT_LOCK_PATH = ".artifacts/dist-artifacts.lock";
const LOCK_POLL_MS = 500;
type ArtifactOwner = { directory: string; unjoinedError?: Error };
let inheritedOwner: ArtifactOwner | undefined;
const activeOwner = new AsyncLocalStorage<ArtifactOwner>();

export function resolveDistArtifactLockPath(rootDir: string) {
  // Subdirectories share checkout ownership; standalone work owns its directory.
  return path.join(findRepoRoot(rootDir) ?? rootDir, DIST_ARTIFACT_LOCK_PATH);
}

function retainUnjoinedDistArtifactWork(owner: ArtifactOwner, error: unknown) {
  if (owner.unjoinedError !== undefined) {
    return owner.unjoinedError;
  }
  if (hasUnjoinedWork(error)) {
    // Latch before I/O: a full disk must not turn uncertain cleanup into permission to release.
    owner.unjoinedError =
      error instanceof Error ? error : new Error("Unjoined artifact work", { cause: error });
    try {
      fs.writeFileSync(path.join(owner.directory, "unjoined"), "Child cleanup was not verified.\n");
    } catch (writeError) {
      owner.unjoinedError = new AggregateError(
        [error, writeError],
        "Could not record unjoined artifact work",
      );
    }
    return owner.unjoinedError;
  }
  return error;
}

export async function runOwnedDistArtifactEntry(script: string, args: string[]) {
  const directory = resolveDistArtifactLockPath(process.cwd());
  const claim = path.join(directory, `child-${process.pid}`);
  // A surviving wrapper claim retains ownership for possibly detached compilers.
  fs.writeFileSync(claim, "Awaiting child completion.\n", { flag: "wx" });
  const owner: ArtifactOwner = { directory };
  // This entry process inherits ownership until exit. Native bundler callbacks
  // can lose async context and run after the CLI module's import has settled.
  inheritedOwner = owner;
  process.argv = [process.execPath, fileURLToPath(script), ...args];
  try {
    await activeOwner.run(owner, () => import(script));
  } catch (error) {
    throw retainUnjoinedDistArtifactWork(owner, error);
  } finally {
    // The pre-existing claim is the durable fence if recording uncertainty failed.
    if (owner.unjoinedError === undefined || fs.existsSync(path.join(directory, "unjoined"))) {
      fs.unlinkSync(claim);
    }
  }
}

const OWNER_RECORD_VERSION = 2;
// ps reports whole seconds, and Linux derives start times from boot-relative ticks.
const START_TIME_TOLERANCE_MS = 2_000;
const PS_TIMEOUT_MS = 5_000;

type ProbeResult = "gone" | "running" | "unreadable";
type OwnerVerdict =
  | { kind: "dead" }
  | { kind: "running"; detail: string }
  | { kind: "unverified"; detail: string };

/** Evidence was missing or unreadable, so the retained owner must not be replaced. */
class UnverifiedOwnerError extends Error {}

function readLinuxStat(pid: number | "self"): { startMs: number; pgid: number } | ProbeResult {
  let stat: string;
  let boot: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    boot = fs.readFileSync("/proc/stat", "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? "gone" : "unreadable";
  }
  // The command name can itself contain spaces and parentheses. Assumes USER_HZ 100.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const btime = Number(/^btime (\d+)$/mu.exec(boot)?.[1]);
  const startMs = btime * 1_000 + Number(fields[19]) * 10;
  const pgid = Number(fields[2]);
  return Number.isFinite(startMs) && Number.isSafeInteger(pgid) ? { startMs, pgid } : "unreadable";
}

function readPsStart(pid: number): { startMs: number; pgid: number } | ProbeResult {
  const result = spawnSync("ps", ["-o", "pgid=,lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PS_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s*$/u.exec(
    result.stdout ?? "",
  );
  const startMs = match ? Date.parse(match[2]!.replace(/\s+/gu, " ")) : Number.NaN;
  if (!result.error && match && !Number.isNaN(startMs)) {
    return { startMs, pgid: Number(match[1]) };
  }
  // ps that could not run, or timed out, leaves the process unobserved.
  if (result.error || result.signal) {
    return "unreadable";
  }
  // An empty listing for a PID the kernel still has is an exiting zombie: it stays running
  // until reaped, which keeps its record held without asking the operator.
  return probeSignal(pid);
}

function readProcessStart(pid: number | "self") {
  if (process.platform === "linux") {
    return readLinuxStat(pid);
  }
  return process.platform === "win32"
    ? "unreadable"
    : readPsStart(pid === "self" ? process.pid : pid);
}

function probeSignal(pid: number): ProbeResult {
  try {
    process.kill(pid, 0);
    return "running";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "gone" : code === "EPERM" ? "running" : "unreadable";
  }
}

/** A matching start time names the recorded process; a different one is a reused PID. */
function probeOwnerProcess(pid: number, identityMs: number): ProbeResult {
  const signalled = probeSignal(pid);
  if (signalled !== "running") {
    return signalled;
  }
  const start = readProcessStart(pid);
  if (typeof start === "string") {
    return start;
  }
  return Math.abs(start.startMs - identityMs) <= START_TIME_TOLERANCE_MS ? "running" : "gone";
}

let ownIdentity: { startIdentity: string; pgid: number } | undefined;
function readOwnIdentity() {
  if (!ownIdentity) {
    const own = readProcessStart("self");
    if (typeof own !== "string") {
      ownIdentity = { startIdentity: new Date(own.startMs).toISOString(), pgid: own.pgid };
    }
  }
  return ownIdentity;
}

const hasMarker = (directory: string, name: string) => fs.existsSync(path.join(directory, name));

const asPid = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 1 && value <= 0x7fffffff
    ? value
    : undefined;

/**
 * Replace a retained owner only on complete same-host evidence: the recorded process is gone
 * or its PID was reused, and its process group plus every recorded child and detached group
 * has no live member. Group checks reuse the managed-child owner, which counts threads, so
 * a pthread_exit leader in state Z with a writing sibling thread stays live. Any read that
 * fails, and any record without this identity, is unverified, never gone.
 */
function assessRetainedOwner(payload: unknown, directory: string): OwnerVerdict {
  const unverified = (detail: string): OwnerVerdict => ({ kind: "unverified", detail });
  if (!isRecord(payload)) {
    return unverified("owner.json is not a readable owner record");
  }
  const pid = asPid(payload.pid);
  const pgid = asPid(payload.pgid);
  const identityMs =
    typeof payload.startIdentity === "string" ? Date.parse(payload.startIdentity) : Number.NaN;
  if (
    payload.version !== OWNER_RECORD_VERSION ||
    pid === undefined ||
    pgid === undefined ||
    Number.isNaN(identityMs) ||
    typeof payload.host !== "string"
  ) {
    // Records from earlier versions keep their original contract: a running owner is waited
    // for, and anything else needs the operator because its children were never recorded.
    if (pid !== undefined && probeSignal(pid) === "running" && !hasMarker(directory, "unjoined")) {
      return { kind: "running", detail: `PID ${pid} is still running` };
    }
    return unverified(
      "the record predates owner identity, so its process start, group and children cannot be checked",
    );
  }
  if (payload.host !== os.hostname()) {
    return unverified(
      `the owner ran on host ${payload.host}, whose processes cannot be observed from ${os.hostname()}`,
    );
  }
  if (process.platform === "win32") {
    return unverified("Windows cannot check a dead owner's detached children");
  }
  const owner = probeOwnerProcess(pid, identityMs);
  if (owner === "running") {
    return { kind: "running", detail: `PID ${pid} is still running` };
  }
  if (owner === "unreadable") {
    return unverified(`the start time of PID ${pid} could not be read`);
  }
  const groups = new Set([pgid]);
  let gap: string | undefined;
  for (const name of fs.readdirSync(directory)) {
    if (name.startsWith("spawning-")) {
      gap ??= "a child was starting when the owner stopped, so its group was not recorded";
      continue;
    }
    const claim = /^(child|group)-(\d+)$/u.exec(name);
    if (!claim) {
      continue;
    }
    const claimed = Number(claim[2]);
    // Entry claims carry no start time, so a live PID cannot be told apart from reuse.
    const claimedProcess = claim[1] === "child" ? probeSignal(claimed) : "gone";
    if (claimedProcess !== "gone") {
      return claimedProcess === "running"
        ? { kind: "running", detail: `child PID ${claimed} is still running` }
        : unverified(`child PID ${claimed} could not be checked`);
    }
    groups.add(claimed);
  }
  // A live member anywhere means waiting; only when none is live do gaps need the operator.
  const ownGroup = readOwnIdentity()?.pgid;
  for (const group of groups) {
    if (group === ownGroup) {
      gap ??= `process group ${group} includes this process, so the owner's members cannot be told apart`;
      continue;
    }
    const state = inspectManagedProcessGroup(
      { pid: group, exitCode: 0, signalCode: null },
      { errorPolicy: "indeterminate" },
    );
    if (state === "live") {
      return {
        kind: "running",
        detail: `process group ${group} still has a live process or thread`,
      };
    }
    if (state === "indeterminate") {
      gap ??= `process group ${group} could not be checked`;
    }
  }
  if (gap) {
    return unverified(gap);
  }
  return { kind: "dead" };
}

/** A reclaimer killed between its guard and removal must not block every later acquirer. */
function clearAbandonedReclaimGuard(ownerPath: string) {
  const guardPath = `${ownerPath}.reclaim`;
  const guard = fs.statSync(guardPath, { throwIfNoEntry: false });
  if (!guard) {
    return;
  }
  let reclaimer: unknown;
  try {
    reclaimer = JSON.parse(fs.readFileSync(guardPath, "utf8"));
  } catch {
    return;
  }
  const pid = isRecord(reclaimer) ? asPid(reclaimer.pid) : undefined;
  // Only a kernel-confirmed exit releases it, and only the exact file inspected above.
  const current = fs.statSync(guardPath, { throwIfNoEntry: false });
  if (
    pid !== undefined &&
    probeSignal(pid) === "gone" &&
    current?.ino === guard.ino &&
    current.mtimeMs === guard.mtimeMs
  ) {
    fs.rmSync(guardPath, { force: true });
  }
}

/** Remove records of groups that have ended; report whether any could still write. */
function settleRecordedGroups(directory: string): boolean {
  let settled = true;
  for (const name of fs.readdirSync(directory)) {
    const group = /^group-(\d+)$/u.exec(name)?.[1];
    if (name.startsWith("spawning-")) {
      settled = false;
    } else if (group) {
      const state = inspectManagedProcessGroup(
        { pid: Number(group), exitCode: 0, signalCode: null },
        { errorPolicy: "indeterminate" },
      );
      if (state === "dead") {
        fs.rmSync(path.join(directory, name), { force: true });
      } else {
        settled = false;
      }
    }
  }
  return settled;
}

export async function acquireDistArtifactOwnership(
  rootDir: string,
  wait = false,
  signal?: AbortSignal,
): Promise<FileLockHandle> {
  const directory = resolveDistArtifactLockPath(fs.realpathSync(rootDir));
  const ownerPath = path.join(directory, "owner.json");
  let reportedWait = false;
  let owner: unknown;
  let held: string | undefined;
  let recovered: string | undefined;
  let lock: FileLockHandle;
  try {
    fs.mkdirSync(directory, { recursive: true });
    const lockRoot = await openLockRoot(directory);
    while (true) {
      signal?.throwIfAborted();
      clearAbandonedReclaimGuard(ownerPath);
      try {
        lock = await acquireFileLock(ownerPath, {
          lockPath: ownerPath,
          // Explicit release owns cleanup; detached children can outlive their parent.
          retainOnExit: true,
          lockRoot,
          payload: () => ({
            version: OWNER_RECORD_VERSION,
            pid: process.pid,
            startedAt: new Date().toISOString(),
            ...readOwnIdentity(),
            host: os.hostname(),
          }),
          // Published updaters call without a signal; retain fs-safe's original wait.
          timeoutMs: wait ? (signal ? LOCK_POLL_MS : Number.POSITIVE_INFINITY) : 0,
          retry: { minTimeout: LOCK_POLL_MS, maxTimeout: LOCK_POLL_MS, factor: 1 },
          staleRecovery: "remove-if-unchanged",
          shouldReclaim: ({ payload, nowMs, staleMs }) => {
            owner = payload;
            // Exclusive creation exposes an empty file before the owner is written.
            // Keep fs-safe's publication grace before judging the record.
            if (payload === null) {
              const pending = fs.statSync(ownerPath, { throwIfNoEntry: false });
              if (pending?.size === 0 && nowMs - pending.mtimeMs < staleMs) {
                return false;
              }
            }
            const verdict = assessRetainedOwner(payload, directory);
            if (verdict.kind === "unverified") {
              // A record released during the checks is fs-safe's to retry, not a refusal.
              if (!fs.existsSync(ownerPath)) {
                return true;
              }
              throw new UnverifiedOwnerError(verdict.detail);
            }
            if (verdict.kind === "running") {
              held = verdict.detail;
              if (!reportedWait) {
                console.error(
                  `[dist artifacts] waiting for checkout ownership: ${directory} (${verdict.detail})`,
                );
                reportedWait = true;
              }
              return false;
            }
            return true;
          },
          // Markers of the verified-dead owner would make the next release retain the lock.
          shouldRemoveStaleLock: () => {
            for (const name of fs.readdirSync(directory)) {
              if (name === "unjoined" || /^(child|group)-\d+$/u.test(name)) {
                fs.rmSync(path.join(directory, name), { force: true });
              }
            }
            const pid = isRecord(owner) ? owner.pid : "unknown";
            recovered = `Recovered ${directory} from dead owner PID ${JSON.stringify(pid)}: its process, group, recorded children and their threads are gone`;
            return true;
          },
        });
        break;
      } catch (error) {
        if (
          !wait ||
          !signal ||
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "file_lock_timeout"
        ) {
          throw error;
        }
      }
    }
  } catch (error) {
    if (signal?.aborted && error === signal.reason) {
      throw error;
    }
    const unverified = error instanceof UnverifiedOwnerError;
    const contended =
      isRecord(error) && (error.code === "file_lock_timeout" || error.code === "file_lock_stale");
    if ((!unverified && !contended) || !fs.existsSync(ownerPath)) {
      throw new Error(
        `Could not acquire ${directory}: ${String(error)}. Resolve this filesystem error and retry before stopping the Gateway.`,
        { cause: error },
      );
    }
    try {
      owner ??= JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    } catch {
      // Unreadable owner fields remain unknown.
    }
    const record = isRecord(owner) ? owner : {};
    const named = `retained by PID ${JSON.stringify(record.pid ?? "unknown")} on host ${JSON.stringify(record.host ?? "unknown")}, started ${JSON.stringify(record.startedAt ?? "unknown")}, start identity ${JSON.stringify(record.startIdentity ?? "unknown")}`;
    if (!unverified) {
      throw new Error(
        `Could not acquire ${directory}: ${named}; ${held ?? "another process is recovering it"}. Wait for that work to finish or stop it, then retry.`,
        { cause: error },
      );
    }
    const release =
      process.platform === "win32"
        ? `Remove-Item -LiteralPath '${directory.replaceAll("'", "''")}' -Recurse -Force`
        : `rm -rf -- '${directory.replaceAll("'", "'\\''")}'`;
    throw new Error(
      `Could not acquire ${directory}: ${named}. Not verified: ${error.message}. Confirm that no build or check from that owner is still running, including detached children; then run \`${release}\` to release and retry.`,
      { cause: error },
    );
  }
  // Acquisition can finish after cancellation; direct callers must never inherit that lock.
  if (signal?.aborted) {
    await lock.release();
    signal.throwIfAborted();
  }
  if (recovered) {
    console.error(`[dist artifacts] ${recovered}`);
  }
  // Managed children record their detached groups here while ownership is held.
  const inherited = process.env[DIST_ARTIFACT_LOCK_DIR_ENV];
  process.env[DIST_ARTIFACT_LOCK_DIR_ENV] = directory;
  const release = async () => {
    await lock.release();
    if (inherited === undefined) {
      delete process.env[DIST_ARTIFACT_LOCK_DIR_ENV];
    } else {
      process.env[DIST_ARTIFACT_LOCK_DIR_ENV] = inherited;
    }
  };
  return { ...lock, release, [Symbol.asyncDispose]: release };
}

/** The callback must join every writer/reader before returning, including on failure. */
export const withDistArtifactOwnership: WithDistArtifactOwnership = async (
  rootDir,
  run,
  signal,
) => {
  const directory = resolveDistArtifactLockPath(fs.realpathSync(rootDir));
  const currentOwner = activeOwner.getStore() ?? inheritedOwner;
  if (directory === currentOwner?.directory) {
    if (currentOwner.unjoinedError !== undefined) {
      throw currentOwner.unjoinedError;
    }
    signal?.throwIfAborted();
    try {
      return await run();
    } catch (error) {
      // A CLI can turn this error into an exit status before the entry launcher sees it.
      // Record uncertain cleanup at the ownership boundary so the parent retains the lock.
      throw retainUnjoinedDistArtifactWork(currentOwner, error);
    }
  }
  const lock = await acquireDistArtifactOwnership(rootDir, true, signal);
  const owner: ArtifactOwner = { directory };
  try {
    signal?.throwIfAborted();
    return await activeOwner.run(owner, run);
  } catch (error) {
    throw retainUnjoinedDistArtifactWork(owner, error);
  } finally {
    if (
      owner.unjoinedError !== undefined ||
      fs.readdirSync(directory).some((name) => name === "unjoined" || name.startsWith("child-")) ||
      !settleRecordedGroups(directory)
    ) {
      console.error(`[dist artifacts] child cleanup unverified; retained ${directory}`);
    } else {
      await lock.release();
    }
  }
};
