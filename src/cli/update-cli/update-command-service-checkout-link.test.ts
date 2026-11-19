import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import { inspectManagedGatewayServiceBeforeUpdate } from "./update-command-service-plan.js";
import { revalidateManagedGatewayServiceAfterUpdate } from "./update-command-service-revalidation.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let home: string;

beforeEach(() => {
  // Service policy applies only to the account's canonical profile; give the fixture one.
  home = dirs.make("update-checkout-link-service-");
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
  vi.stubEnv("OPENCLAW_HOME", undefined);
  mockSystemAccountHome();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function writeInstall(root: string, version: string, checkout = false) {
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "dist", "index.js"), "export {};\n");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version }),
  );
  if (checkout) {
    for (const marker of [".git", "src", "extensions"]) {
      await fs.mkdir(path.join(root, marker));
    }
  }
}

function serviceRunning(root: string): GatewayServiceState {
  return {
    installed: true,
    running: true,
    loadState: { status: "loaded" },
    env: { HOME: home },
    command: {
      programArguments: [process.execPath, path.join(root, "dist", "index.js"), "gateway", "run"],
    },
    definitionMutationCapability: { kind: "writable" },
    runtime: { status: "running", pid: 4242, systemd: { managerUid: 1000 } },
  } as GatewayServiceState;
}

/**
 * The installation `openclaw` names is a pnpm global link to a Git checkout; the
 * Gateway service runs that checkout. A switch to the package replaces the link.
 */
async function checkoutLinkLayout() {
  const base = home;
  const checkout = path.join(base, "checkout");
  const link = path.join(base, "pnpm", "global", "v11", "group", "node_modules", "openclaw");
  const packageRoot = path.join(base, "pnpm", "global", "v11", "store", "openclaw");
  await writeInstall(checkout, "2026.11.5", true);
  await writeInstall(packageRoot, "2026.11.19");
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(checkout, link);
  const state = serviceRunning(checkout);
  const verdict = await inspectManagedGatewayServiceBeforeUpdate({ root: link, state });
  const before = { serviceEnv: state.env, serviceManagerUid: 1000, serviceUpdateVerdict: verdict };
  const swapLink = async () => {
    await fs.unlink(link);
    await fs.symlink(packageRoot, link);
  };
  return { checkout, link, packageRoot, state, verdict, before, swapLink };
}

it("keeps the checkout as the stopped service's installation after the link moves", async () => {
  const layout = await checkoutLinkLayout();
  expect(layout.verdict).toMatchObject({ kind: "owned", refreshDefinition: true });
  await layout.swapLink();

  // The restart after the swap names the new package root; the unit still runs the checkout.
  const afterSwap = await revalidateManagedGatewayServiceAfterUpdate({
    state: layout.state,
    root: layout.link,
    preManagedServiceStop: layout.before,
    allowInstallRootChange: true,
  });
  expect(afterSwap).toMatchObject({ kind: "owned", requiresInstallRootRefresh: true });

  // Rollback and recovery revalidate the same stopped service against the restored root.
  await expect(
    revalidateManagedGatewayServiceAfterUpdate({
      state: layout.state,
      root: await fs.realpath(layout.checkout),
      preManagedServiceStop: layout.before,
    }),
  ).resolves.toMatchObject({ kind: "owned" });
});

it("still refuses a service that another installation took over", async () => {
  const layout = await checkoutLinkLayout();
  await layout.swapLink();
  const elsewhere = path.join(path.dirname(layout.checkout), "elsewhere");
  await writeInstall(elsewhere, "2026.11.5", true);

  await expect(
    revalidateManagedGatewayServiceAfterUpdate({
      state: serviceRunning(elsewhere),
      root: layout.link,
      preManagedServiceStop: layout.before,
      allowInstallRootChange: true,
    }),
  ).rejects.toThrow("Gateway service ownership or manager identity changed");
});
