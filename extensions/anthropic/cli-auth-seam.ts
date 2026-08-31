/**
 * Claude CLI auth seam. Setup may prompt for keychain-backed credentials while
 * runtime paths stay non-interactive.
 */
import { spawnSync } from "node:child_process";
import { readClaudeCliCredentialsCached } from "openclaw/plugin-sdk/provider-auth";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLAUDE_CLI_CLEAR_ENV } from "./cli-shared.js";

type ClaudeCliAuthStatus = { status: "available" } | { status: "missing" | "unreadable" };

/** Ask Claude CLI whether its own login is usable without reading token material. */
export function probeClaudeCliAuthStatus(params?: {
  command?: string;
  env?: NodeJS.ProcessEnv;
}): ClaudeCliAuthStatus {
  const env = { ...(params?.env ?? process.env) };
  for (const name of CLAUDE_CLI_CLEAR_ENV) {
    delete env[name];
  }
  const result = spawnSync(params?.command ?? "claude", ["auth", "status", "--json"], {
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024,
    timeout: 3_000,
    windowsHide: true,
  });
  if (result.error || result.status === null) {
    return { status: "unreadable" };
  }
  if (result.status !== 0) {
    return { status: "missing" };
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!isRecord(parsed) || parsed.loggedIn !== true) {
      return { status: "missing" };
    }
    return { status: "available" };
  } catch {
    return { status: "unreadable" };
  }
}

/** Read Claude CLI credentials for interactive setup paths. */
export function readClaudeCliCredentialsForSetup() {
  return readClaudeCliCredentialsCached();
}

/** Read Claude CLI credentials for setup checks that must not prompt. */
export function readClaudeCliCredentialsForSetupNonInteractive() {
  let unreadable = false;
  const credential = readClaudeCliCredentialsCached({
    allowKeychainPrompt: false,
    tryKeychainWithoutPrompt: true,
    ttlMs: 0,
    onStoredCredentialUnreadable: () => {
      unreadable = true;
    },
  });
  return credential
    ? ({ status: "available", credential } as const)
    : ({ status: unreadable ? "unreadable" : "missing" } as const);
}

/** Read Claude CLI credentials for runtime without keychain prompts. */
export function readClaudeCliCredentialsForRuntime() {
  return readClaudeCliCredentialsCached({ allowKeychainPrompt: false });
}
