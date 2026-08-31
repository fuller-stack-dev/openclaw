import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDashboardInTerminal } from "./dashboard-terminal-browser.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

function createChildProcess(): ChildProcess {
  return new EventEmitter() as ChildProcess;
}

describe("openDashboardInTerminal", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("runs terminal-browser app mode in the current terminal", async () => {
    const child = createChildProcess();
    spawnMock.mockReturnValue(child);

    const resultPromise = openDashboardInTerminal("http://127.0.0.1:18789/#bootstrapToken=one");
    child.emit("exit", 0, null);

    await expect(resultPromise).resolves.toEqual({ ok: true, value: undefined });
    expect(spawnMock).toHaveBeenCalledWith(
      "terminal-browser",
      ["open", "http://127.0.0.1:18789/#bootstrapToken=one", "--app-mode"],
      { stdio: "inherit" },
    );
  });

  it("returns an install hint when terminal-browser is missing", async () => {
    const child = createChildProcess();
    spawnMock.mockReturnValue(child);

    const resultPromise = openDashboardInTerminal("http://127.0.0.1:18789/");
    child.emit(
      "error",
      Object.assign(new Error("spawn terminal-browser ENOENT"), { code: "ENOENT" }),
    );

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error:
        "terminal-browser is not installed. Install it from https://github.com/zenbu-labs/terminal-browser, then retry.",
    });
  });

  it("reports a nonzero terminal-browser exit", async () => {
    const child = createChildProcess();
    spawnMock.mockReturnValue(child);

    const resultPromise = openDashboardInTerminal("http://127.0.0.1:18789/");
    child.emit("exit", 1, null);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: "terminal-browser exited with status 1.",
    });
  });
});
