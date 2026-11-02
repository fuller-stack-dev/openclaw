import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as fileLock from "@openclaw/fs-safe/file-lock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireDistArtifactOwnership,
  resolveDistArtifactLockPath,
  withDistArtifactOwnership,
} from "../../scripts/lib/dist-artifact-lock.mts";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { waitForDead } from "../helpers/process-wait.js";
import { createDeferred } from "../helpers/promise.js";

const lockModule = pathToFileURL(path.resolve("scripts/lib/dist-artifact-lock.mts")).href;
const managedModule = pathToFileURL(path.resolve("scripts/lib/managed-child-process.mts")).href;

vi.mock("@openclaw/fs-safe/file-lock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/file-lock")>()),
  acquireFileLock: vi.fn(),
}));
const actual = await vi.importActual<typeof import("@openclaw/fs-safe/file-lock")>(
  "@openclaw/fs-safe/file-lock",
);
const acquire = vi.mocked(fileLock.acquireFileLock);
const callback = vi.fn();
let root: string;
let ownerPath: string;
let controller: AbortController;
beforeEach(() => {
  acquire.mockReset().mockImplementation(actual.acquireFileLock);
  callback.mockReset();
  root = fs.realpathSync(fixture.createTempDir("openclaw-lock-cancel-"));
  // Keep checkout discovery from selecting an ancestor of the temporary fixture.
  fs.mkdirSync(path.join(root, ".git"));
  ownerPath = path.join(resolveDistArtifactLockPath(root), "owner.json");
  controller = new AbortController();
});
const fixture = createFixtureLifetime();
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.cleanup();
});
const readOwner = () => fs.readFileSync(ownerPath, "utf8");
const lockFile = (name: string) => path.join(path.dirname(ownerPath), name);
/** A refusal names the owner, what was not verified, and the one command that clears it. */
async function expectRecoverableRefusal(attempt: Promise<unknown>, unverified: string) {
  const failure = await attempt.then(
    () => undefined,
    (error: unknown) => error,
  );
  const message = failure instanceof Error ? failure.message : String(failure);
  const directory = path.dirname(ownerPath);
  expect(message).toContain(`Could not acquire ${directory}: retained by PID`);
  expect(message).toContain(`Not verified: ${unverified}`);
  expect(message).toContain(`rm -rf -- '${directory}'`);
  return message;
}

it("waits for an empty ownership record being published before acquiring", async () => {
  fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
  fs.writeFileSync(ownerPath, "");
  acquire.mockImplementation(async (...args) => {
    try {
      return await actual.acquireFileLock(...args);
    } catch (error) {
      // Finish the creator's release after a real contention attempt observes
      // the empty file exposed between exclusive creation and payload write.
      fs.unlinkSync(ownerPath);
      acquire.mockImplementation(actual.acquireFileLock);
      throw error;
    }
  });
  await withDistArtifactOwnership(root, callback, controller.signal);
  expect(callback).toHaveBeenCalledOnce();
  expect(fs.existsSync(ownerPath)).toBe(false);
});

it.for([false, true])(
  "refuses an abandoned empty record with its recovery command (unjoined=%s)",
  async (unjoined) => {
    fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
    fs.writeFileSync(ownerPath, "");
    if (unjoined) {
      fs.writeFileSync(lockFile("unjoined"), "Unverified child cleanup.\n");
    }
    // Past fs-safe's publication grace, nothing identifies a writer.
    fs.utimesSync(ownerPath, new Date(0), new Date(0));
    await expectRecoverableRefusal(
      withDistArtifactOwnership(root, callback, controller.signal),
      "owner.json is not a readable owner record",
    );
    expect(callback).not.toHaveBeenCalled();
    expect(readOwner()).toBe("");
  },
);

it("cancels an already contended same-process waiter without disturbing the owner", async () => {
  const enteredOwner = createDeferred();
  const releaseOwner = createDeferred();
  const owner = withDistArtifactOwnership(root, async () => {
    enteredOwner.resolve();
    await releaseOwner.promise;
  });
  await enteredOwner.promise;
  const originalOwner = readOwner();
  const attempted = createDeferred();
  acquire.mockImplementation(async (...args) => {
    try {
      return await actual.acquireFileLock(...args);
    } catch (error) {
      // Observe a real completed contention attempt, not merely waiter startup.
      attempted.resolve();
      throw error;
    }
  });
  const waiter = withDistArtifactOwnership(root, callback, controller.signal).catch(
    (error: unknown) => error,
  );
  try {
    await attempted.promise;
    controller.abort();
    expect(await waiter).toBe(controller.signal.reason);
    expect(callback).not.toHaveBeenCalled();
    expect(readOwner()).toBe(originalOwner);
  } finally {
    controller.abort();
    releaseOwner.resolve();
    await Promise.all([owner, waiter]);
  }
  await withDistArtifactOwnership(root, async () => {});
  expect(fs.existsSync(ownerPath)).toBe(false);
});

it.for([
  { direct: false, fails: true },
  { direct: true, fails: false },
])(
  "joins acquisition-race release before rejecting (direct=$direct, release fails=$fails)",
  async ({ direct, fails }) => {
    const entered = createDeferred();
    const acquired = createDeferred<fileLock.FileLockHandle>();
    const releasing = createDeferred();
    const released = createDeferred();
    const failure = new Error("release failed");
    const release = vi.fn(async () => {
      releasing.resolve();
      await released.promise;
      if (fails) {
        throw failure;
      }
    });
    acquire.mockImplementation(async () => {
      entered.resolve();
      return await acquired.promise;
    });
    let settled = false;
    const waiter = (
      direct
        ? acquireDistArtifactOwnership(root, true, controller.signal)
        : withDistArtifactOwnership(root, callback, controller.signal)
    )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await entered.promise;
    controller.abort();
    acquired.resolve({
      lockPath: resolveDistArtifactLockPath(root),
      normalizedTargetPath: root,
      verifyStillHeld: async () => true,
      release,
      [Symbol.asyncDispose]: release,
    });
    await releasing.promise;
    expect(callback).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    released.resolve();
    expect(await waiter).toBe(fails ? failure : controller.signal.reason);
    expect(release).toHaveBeenCalledOnce();
  },
);

it("preserves an acquisition cleanup failure racing cancellation", async () => {
  const failure = new Error("acquisition cleanup failed");
  acquire.mockImplementation(async () => {
    controller.abort();
    throw failure;
  });
  await expect(withDistArtifactOwnership(root, callback, controller.signal)).rejects.toMatchObject({
    cause: failure,
    message: expect.stringContaining("filesystem error"),
  });
  expect(callback).not.toHaveBeenCalled();
});

it("does not acquire for an already cancelled waiter", async () => {
  const signal = AbortSignal.abort();
  await expect(withDistArtifactOwnership(root, callback, signal)).rejects.toBe(signal.reason);
  expect(acquire).not.toHaveBeenCalled();
});

it("keeps the published two-argument wait inside one native acquisition", async () => {
  const failure = Object.assign(new Error("native timeout"), { code: "file_lock_timeout" });
  acquire.mockRejectedValue(failure);
  await expect(withDistArtifactOwnership(root, callback)).rejects.toMatchObject({
    cause: failure,
  });
  expect(acquire).toHaveBeenCalledOnce();
  expect(acquire.mock.calls[0]?.[1]?.timeoutMs).toBe(Number.POSITIVE_INFINITY);
});

describe("retained records from interrupted owners", () => {
  const ownedGroups = new Set<number>();
  afterEach(async () => {
    const signal = AbortSignal.timeout(10_000);
    await Promise.all(
      [...ownedGroups].map(async (pid) => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // The group already exited; the wait below confirms its leader is gone.
        }
        await waitForDead(pid, signal, "reject");
      }),
    );
    ownedGroups.clear();
  });
  const node = (script: string, env: NodeJS.ProcessEnv = process.env) => {
    // Own process group, as a build launched from a shell or an update launcher has.
    const child = spawn(resolveTestNodeExecPath(), ["--input-type=module", "-e", script], {
      cwd: root,
      detached: true,
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    ownedGroups.add(child.pid!);
    return child;
  };
  const firstLine = async (child: ChildProcess) => {
    const [data] = (await once(child.stdout!, "data")) as [Buffer];
    return data.toString().trim();
  };
  const exited = (child: ChildProcess) =>
    child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "close");
  const sigkill = async (child: ChildProcess) => {
    const closed = exited(child);
    child.kill("SIGKILL");
    await closed;
  };
  const deadPid = async () => {
    const child = node("");
    await exited(child);
    return child.pid!;
  };
  /** Takes real ownership and optionally starts a managed, detached child, then idles. */
  const startHolder = async (child?: { bin: string; args: string[]; readyFile: string }) => {
    // A killed holder never releases its child's resource claim, so give it a private owner
    // instead of the Vitest worker's namespace.
    const resources = path.join(root, "holder-tmp");
    fs.mkdirSync(resources);
    createVitestResourceOwner(resources);
    const holder = node(
      `import fs from "node:fs";
      import { acquireDistArtifactOwnership } from ${JSON.stringify(lockModule)};
      import { runManagedCommand } from ${JSON.stringify(managedModule)};
      await acquireDistArtifactOwnership(${JSON.stringify(root)});
      const child = ${JSON.stringify(child ?? null)};
      if (child) {
        void runManagedCommand({ bin: child.bin, args: child.args, stdio: "ignore" }).catch(() => {});
        while (!fs.existsSync(child.readyFile)) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      console.log("held");
      setInterval(() => {}, 1000);`,
      { ...process.env, TMPDIR: resources, TMP: resources, TEMP: resources },
    );
    expect(await firstLine(holder)).toBe("held");
    const groups = fs
      .readdirSync(path.dirname(ownerPath))
      .flatMap((name) => /^group-(\d+)$/u.exec(name)?.[1] ?? [])
      .map(Number);
    for (const group of groups) {
      ownedGroups.add(group);
    }
    return { holder, groups };
  };
  const writeRecord = (record: Record<string, unknown>) => {
    fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
    fs.writeFileSync(ownerPath, JSON.stringify(record));
  };
  const expectRecovered = async () => {
    const lock = await acquireDistArtifactOwnership(root);
    expect(JSON.parse(readOwner())).toMatchObject({ pid: process.pid, host: os.hostname() });
    await lock.release();
    expect(fs.existsSync(ownerPath)).toBe(false);
  };
  const expectHeldBy = async (detail: string) => {
    const before = readOwner();
    await expect(acquireDistArtifactOwnership(root)).rejects.toThrow(detail);
    expect(readOwner()).toBe(before);
  };
  const currentRecord = async (overrides: Record<string, unknown> = {}) => {
    const pid = await deadPid();
    const now = new Date();
    return {
      version: 2,
      pid,
      pgid: pid,
      startedAt: now.toISOString(),
      startIdentity: now.toISOString(),
      host: os.hostname(),
      ...overrides,
    };
  };

  it("recovers a SIGKILLed owner once its process, group and children are verifiably gone", async () => {
    const { holder } = await startHolder();
    await sigkill(holder);
    await expectRecovered();
  });

  it("keeps ownership while a recorded detached child outlives its owner", async () => {
    const ready = path.join(root, "child.ready");
    const { holder, groups } = await startHolder({
      bin: resolveTestNodeExecPath(),
      args: [
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(ready)}, ""); setInterval(() => {}, 1000)`,
      ],
      readyFile: ready,
    });
    expect(groups).toHaveLength(1);
    await sigkill(holder);
    await expectHeldBy(`process group ${groups[0]} still has a live process or thread`);
    process.kill(-groups[0]!, "SIGKILL");
    await waitForDead(groups[0]!, AbortSignal.timeout(5_000), "reject");
    await expectRecovered();
  });

  // Root cause of the reviewed counterexample: a native writer's leader called pthread_exit,
  // so /proc shows it as Z while a sibling thread keeps writing. Leader state is not death.
  it.runIf(process.platform === "linux")(
    "keeps ownership while a zombie group leader's sibling thread still writes",
    async () => {
      const output = path.join(root, "writer.out");
      const writer = path.join(root, "writer.py");
      fs.writeFileSync(
        writer,
        [
          "import ctypes, sys, threading, time",
          "def write():",
          "    while True:",
          "        with open(sys.argv[1], 'a') as out:",
          "            out.write('x')",
          "        time.sleep(0.02)",
          "threading.Thread(target=write).start()",
          "time.sleep(0.2)",
          "ctypes.CDLL(None).pthread_exit(None)",
        ].join("\n"),
      );
      const { holder, groups } = await startHolder({
        bin: "python3",
        args: [writer, output],
        readyFile: output,
      });
      const leader = groups[0]!;
      await vi.waitFor(
        () => expect(fs.readFileSync(`/proc/${leader}/stat`, "utf8")).toMatch(/\) Z /u),
        { timeout: 5_000, interval: 20 },
      );
      await sigkill(holder);
      await expectHeldBy(`process group ${leader} still has a live process or thread`);
      const written = fs.statSync(output).size;
      await vi.waitFor(() => expect(fs.statSync(output).size).toBeGreaterThan(written), {
        timeout: 5_000,
        interval: 20,
      });
    },
  );

  it("never takes ownership from a running owner", async () => {
    const { holder } = await startHolder();
    await expectHeldBy(`PID ${holder.pid} is still running`);
    expect(holder.exitCode).toBeNull();
  });

  it("treats a recorded PID that now names a newer process as a dead owner", async () => {
    const unrelated = node(`console.log("ready"); setInterval(() => {}, 1000);`);
    await firstLine(unrelated);
    const lastHour = new Date(Date.now() - 3_600_000).toISOString();
    writeRecord(
      await currentRecord({ pid: unrelated.pid, startedAt: lastHour, startIdentity: lastHour }),
    );
    await expectRecovered();
    expect(unrelated.exitCode).toBeNull();
  });

  it("refuses a record from another host, however old", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    writeRecord(
      await currentRecord({ host: "build-peer", startedAt: twoDaysAgo, startIdentity: twoDaysAgo }),
    );
    const message = await expectRecoverableRefusal(
      acquireDistArtifactOwnership(root),
      `the owner ran on host build-peer, whose processes cannot be observed from ${os.hostname()}`,
    );
    expect(message).toContain(`on host "build-peer", started "${twoDaysAgo}"`);
  });

  it("refuses when a child was starting as the owner stopped", async () => {
    writeRecord(await currentRecord());
    fs.writeFileSync(lockFile("spawning-123-1"), "");
    await expectRecoverableRefusal(
      acquireDistArtifactOwnership(root),
      "a child was starting when the owner stopped, so its group was not recorded",
    );
  });

  // Acquire in a child whose ps is missing (empty PATH) or denied (macOS sandbox profile).
  const acquireWhere = async (ps: "missing" | "denied") => {
    const script = `import { acquireDistArtifactOwnership } from ${JSON.stringify(lockModule)};
      await acquireDistArtifactOwnership(${JSON.stringify(root)}).then(
        (lock) => lock.release().then(() => console.log(JSON.stringify("acquired"))),
        (error) => console.log(JSON.stringify(error.message)),
      );`;
    const args = ["--input-type=module", "-e", script];
    const attempt =
      ps === "denied"
        ? spawn(
            "/usr/bin/sandbox-exec",
            [
              "-p",
              '(version 1)(allow default)(deny process-exec (literal "/bin/ps"))',
              resolveTestNodeExecPath(),
              ...args,
            ],
            { cwd: root, stdio: ["ignore", "pipe", "inherit"] },
          )
        : spawn(resolveTestNodeExecPath(), args, {
            cwd: root,
            env: { ...process.env, PATH: "/nonexistent" },
            stdio: ["ignore", "pipe", "inherit"],
          });
    const outcome = JSON.parse(await firstLine(attempt)) as string;
    await exited(attempt);
    return outcome;
  };
  const psCases = [
    "missing",
    ...(process.platform === "darwin" ? (["denied"] as const) : []),
  ] as const;

  // The reviewed gap: without ps, a dead owner's detached child went unchecked.
  it.each(psCases)("keeps ownership for a live detached child when ps is %s", async (ps) => {
    const ready = path.join(root, "child.ready");
    const { holder, groups } = await startHolder({
      bin: resolveTestNodeExecPath(),
      args: [
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(ready)}, ""); setInterval(() => {}, 1000)`,
      ],
      readyFile: ready,
    });
    await sigkill(holder);
    const before = readOwner();
    expect(await acquireWhere(ps)).toContain(
      `process group ${groups[0]} still has a live process or thread`,
    );
    expect(readOwner()).toBe(before);
  });

  // Linux reads start times from /proc, so only platforms that need ps can lose them.
  it.runIf(process.platform !== "linux").each(psCases)(
    "refuses an owner whose start time cannot be read when ps is %s",
    async (ps) => {
      const unrelated = node(`console.log("ready"); setInterval(() => {}, 1000);`);
      await firstLine(unrelated);
      const lastHour = new Date(Date.now() - 3_600_000).toISOString();
      writeRecord(
        await currentRecord({ pid: unrelated.pid, startedAt: lastHour, startIdentity: lastHour }),
      );
      await expectRecoverableRefusal(
        Promise.reject(new Error(await acquireWhere(ps))),
        `the start time of PID ${unrelated.pid} could not be read`,
      );
      expect(unrelated.exitCode).toBeNull();
    },
  );

  // A record in the shape current main writes, as an interrupted update leaves it.
  it("keeps the earlier record format's contract", async () => {
    const { holder } = await startHolder();
    const running = holder.pid!;
    const legacy = JSON.stringify({ pid: running, startedAt: new Date().toISOString() });
    fs.writeFileSync(ownerPath, legacy);
    await expectHeldBy(`PID ${running} is still running`);
    await sigkill(holder);
    const message = await expectRecoverableRefusal(
      acquireDistArtifactOwnership(root),
      "the record predates owner identity, so its process start, group and children cannot be checked",
    );
    expect(message).toContain(`retained by PID ${running} on host "unknown"`);
    expect(readOwner()).toBe(legacy);
  });

  it("removes a kernel-confirmed abandoned reclaim guard", async () => {
    writeRecord(await currentRecord());
    fs.writeFileSync(`${ownerPath}.reclaim`, JSON.stringify({ pid: await deadPid() }));
    await expectRecovered();
    expect(fs.existsSync(`${ownerPath}.reclaim`)).toBe(false);
  });

  it("drops a managed child's group record once that group has exited", async () => {
    await withDistArtifactOwnership(root, async () => {
      await runManagedCommand({
        bin: resolveTestNodeExecPath(),
        args: ["-e", ""],
        stdio: "ignore",
      });
    });
    // A leftover record would have retained the lock for every later acquirer.
    expect(fs.readdirSync(path.dirname(ownerPath))).toEqual([]);
  });

  it("admits one owner at a time when several processes recover the same record", async () => {
    const { holder } = await startHolder();
    await sigkill(holder);
    const log = path.join(root, "owners.log");
    const contenders = Array.from({ length: 3 }, () =>
      node(
        `import fs from "node:fs";
        import { withDistArtifactOwnership } from ${JSON.stringify(lockModule)};
        await withDistArtifactOwnership(${JSON.stringify(root)}, async () => {
          fs.appendFileSync(${JSON.stringify(log)}, "enter\\n");
          await new Promise((resolve) => setTimeout(resolve, 100));
          fs.appendFileSync(${JSON.stringify(log)}, "exit\\n");
        });`,
      ),
    );
    await Promise.all(contenders.map(exited));
    expect(contenders.map((child) => child.exitCode)).toEqual([0, 0, 0]);
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "enter",
      "exit",
      "enter",
      "exit",
      "enter",
      "exit",
    ]);
  });
});
