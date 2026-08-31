import { spawn } from "node:child_process";
import { err, ok, type Result } from "@openclaw/normalization-core/result";

function formatTerminalBrowserError(error: unknown): string {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return "terminal-browser is not installed. Install it from https://github.com/zenbu-labs/terminal-browser, then retry.";
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Could not start terminal-browser: ${message}`;
}

/** Open a URL with Terminal Browser and keep this CLI attached until the app closes. */
export async function openDashboardInTerminal(url: string): Promise<Result<void, string>> {
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
      const child = spawn("terminal-browser", ["open", url, "--app-mode"], {
        stdio: "inherit",
      });
      child.once("error", (error) => finish(err(formatTerminalBrowserError(error))));
      child.once("exit", (code, signal) => {
        if (code === 0) {
          finish(ok(undefined));
          return;
        }
        if (signal) {
          finish(err(`terminal-browser exited after signal ${signal}.`));
          return;
        }
        finish(err(`terminal-browser exited with status ${code ?? "unknown"}.`));
      });
    } catch (error) {
      finish(err(formatTerminalBrowserError(error)));
    }
  });
}
