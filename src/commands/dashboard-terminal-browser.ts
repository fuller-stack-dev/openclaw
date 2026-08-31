import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { x as extractTar } from "tar";
import { resolveStateDir } from "../config/paths.js";
import { sha256File } from "../infra/crypto-digest.js";
import { withFileLock } from "../infra/file-lock.js";
import type { RuntimeEnv } from "../runtime.js";

const TERMINAL_BROWSER_VERSION = "v0.6.0";
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const INSTALL_LOCK_OPTIONS = {
  retries: {
    retries: 180,
    factor: 1.1,
    minTimeout: 250,
    maxTimeout: 1_000,
    randomize: true,
  },
  stale: 30 * 60_000,
} as const;

type TerminalBrowserArtifact = {
  url: string;
  sha256: string;
  size: number;
};

// Pinned from the upstream v0.6.0 installer manifest. The digest is checked
// before any downloaded bytes are extracted or executed.
const TERMINAL_BROWSER_ARTIFACTS: Record<string, TerminalBrowserArtifact> = {
  "darwin-arm64": {
    url: "https://github.com/zenbu-labs/terminal-browser/releases/download/v0.6.0/terminal-browser-darwin-arm64.tar.gz",
    sha256: "d2d1a060b6208f1c8c504a1af825eed0fb05bfadbd8b23f1e0065619c577e749",
    size: 130_152_172,
  },
  "linux-arm64": {
    url: "https://github.com/zenbu-labs/terminal-browser/releases/download/v0.6.0/terminal-browser-linux-arm64.tar.gz",
    sha256: "24d06ce26fdb8417114d614c5bf16ee481aab5733f49e24f557ca7a041a82f4a",
    size: 135_205_982,
  },
  "linux-x64": {
    url: "https://github.com/zenbu-labs/terminal-browser/releases/download/v0.6.0/terminal-browser-linux-x64.tar.gz",
    sha256: "7c2375593623a12109615eca94ceaeece6a6193c4cc955ba159215f0f6c09ff7",
    size: 137_362_872,
  },
};

function resolveTerminalBrowserArtifact(): Result<TerminalBrowserArtifact, string> {
  const target = `${process.platform}-${process.arch}`;
  const artifact = TERMINAL_BROWSER_ARTIFACTS[target];
  return artifact
    ? ok(artifact)
    : err(`Terminal Browser ${TERMINAL_BROWSER_VERSION} does not support ${target}.`);
}

function resolveManagedTerminalBrowserPaths() {
  const toolsDir = path.join(resolveStateDir(), "tools", "terminal-browser");
  const versionDir = path.join(toolsDir, TERMINAL_BROWSER_VERSION);
  return {
    toolsDir,
    versionDir,
    binaryPath: path.join(versionDir, "bin", "terminal-browser"),
    versionPath: path.join(versionDir, "VERSION"),
  };
}

async function isTerminalBrowserInstallReady(paths: {
  binaryPath: string;
  versionPath: string;
}): Promise<boolean> {
  try {
    const [version, binary] = await Promise.all([
      fs.readFile(paths.versionPath, "utf8"),
      fs.lstat(paths.binaryPath),
    ]);
    await fs.access(paths.binaryPath, fs.constants.X_OK);
    return version.trim() === TERMINAL_BROWSER_VERSION && binary.isFile();
  } catch {
    return false;
  }
}

async function downloadTerminalBrowser(
  artifact: TerminalBrowserArtifact,
  archivePath: string,
): Promise<void> {
  const response = await fetch(artifact.url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": "OpenClaw terminal-ui setup",
    },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`download failed with HTTP ${response.status}`);
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/u.test(declaredLength)) {
    const declaredBytes = Number(declaredLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > artifact.size) {
      await response.body.cancel().catch(() => undefined);
      throw new Error(`download exceeds the pinned ${artifact.size}-byte artifact size`);
    }
  }

  let downloadedBytes = 0;
  const byteLimit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloadedBytes += chunk.length;
      if (downloadedBytes > artifact.size) {
        callback(new Error(`download exceeds the pinned ${artifact.size}-byte artifact size`));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
    byteLimit,
    createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
  );
  if (downloadedBytes !== artifact.size) {
    throw new Error(
      `download size mismatch (expected ${artifact.size} bytes, received ${downloadedBytes})`,
    );
  }
}

async function installManagedTerminalBrowser(runtime: RuntimeEnv): Promise<Result<string, string>> {
  const artifactResult = resolveTerminalBrowserArtifact();
  if (!artifactResult.ok) {
    return artifactResult;
  }
  const artifact = artifactResult.value;
  const paths = resolveManagedTerminalBrowserPaths();
  await fs.mkdir(paths.toolsDir, { recursive: true, mode: 0o700 });

  try {
    return await withFileLock(
      path.join(paths.toolsDir, "install"),
      INSTALL_LOCK_OPTIONS,
      async () => {
        if (await isTerminalBrowserInstallReady(paths)) {
          return ok(paths.binaryPath);
        }
        try {
          await fs.access(paths.versionDir);
          return err(
            `The managed Terminal Browser install at ${paths.versionDir} is incomplete. Move it aside and retry.`,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }

        runtime.log(
          `Installing Terminal Browser ${TERMINAL_BROWSER_VERSION} (${Math.ceil(artifact.size / 1_000_000)} MB)…`,
        );
        const stagingDir = await fs.mkdtemp(path.join(paths.toolsDir, ".install-"));
        const archivePath = path.join(stagingDir, "terminal-browser.tar.gz");
        const extractedDir = path.join(stagingDir, "app");
        try {
          await downloadTerminalBrowser(artifact, archivePath);
          const actualSha256 = await sha256File(archivePath);
          if (actualSha256 !== artifact.sha256) {
            throw new Error(
              `checksum mismatch (expected ${artifact.sha256}, received ${actualSha256})`,
            );
          }
          await fs.mkdir(extractedDir, { mode: 0o700 });
          await extractTar({
            file: archivePath,
            cwd: extractedDir,
            gzip: true,
            strip: 1,
            preservePaths: false,
            preserveOwner: false,
            strict: true,
          });
          const stagedPaths = {
            binaryPath: path.join(extractedDir, "bin", "terminal-browser"),
            versionPath: path.join(extractedDir, "VERSION"),
          };
          await fs.chmod(stagedPaths.binaryPath, 0o755);
          if (!(await isTerminalBrowserInstallReady(stagedPaths))) {
            throw new Error(
              "the extracted release is missing its expected binary or version receipt",
            );
          }
          await fs.rename(extractedDir, paths.versionDir);
          runtime.log(`Installed Terminal Browser ${TERMINAL_BROWSER_VERSION}.`);
          return ok(paths.binaryPath);
        } finally {
          await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
        }
      },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return err(`Could not install Terminal Browser ${TERMINAL_BROWSER_VERSION}: ${detail}`);
  }
}

function checkLinuxTerminalBrowserLibraries(binaryPath: string): Result<void, string> {
  if (process.platform !== "linux") {
    return ok(undefined);
  }
  const electronPath = path.join(path.dirname(binaryPath), "..", "electron", "electron");
  const result = spawnSync("ldd", [electronPath], { encoding: "utf8" });
  const missing = result.stdout
    .split("\n")
    .filter((line) => line.includes("not found"))
    .map((line) => line.trim().split(/\s+/u)[0])
    .filter(Boolean);
  if (missing.length === 0) {
    return ok(undefined);
  }
  return err(
    `Terminal Browser is installed, but Linux is missing: ${missing.join(", ")}. Install the matching system libraries and retry (Debian/Ubuntu: sudo apt-get install libnss3 libgtk-3-0 libasound2t64 libgbm1).`,
  );
}

function formatTerminalBrowserError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Could not start Terminal Browser: ${message}`;
}

/** Provision Terminal Browser, then keep this CLI attached until the Control UI closes. */
export async function openDashboardInTerminal(
  url: string,
  runtime: RuntimeEnv,
): Promise<Result<void, string>> {
  const installResult = await installManagedTerminalBrowser(runtime);
  if (!installResult.ok) {
    return installResult;
  }
  const libraryResult = checkLinuxTerminalBrowserLibraries(installResult.value);
  if (!libraryResult.ok) {
    return libraryResult;
  }

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: Result<void, string>) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    try {
      // Keep the embedded surface app-like while preserving Terminal Browser's page context menu.
      const browserArgs = [
        "open",
        url,
        "--no-toolbar",
        "--no-shortcuts",
        "--no-overlays",
        "--no-frame",
        "--allow-clipboard-read",
        "--open-tabs-in-popup-stack",
      ];
      const child = spawn(installResult.value, browserArgs, {
        stdio: "inherit",
      });
      child.once("error", (error) => finish(err(formatTerminalBrowserError(error))));
      child.once("exit", (code, signal) => {
        if (code === 0) {
          finish(ok(undefined));
          return;
        }
        if (signal) {
          finish(err(`Terminal Browser exited after signal ${signal}.`));
          return;
        }
        finish(err(`Terminal Browser exited with status ${code ?? "unknown"}.`));
      });
    } catch (error) {
      finish(err(formatTerminalBrowserError(error)));
    }
  });
}
