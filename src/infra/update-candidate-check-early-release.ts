import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import type { OpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import { collectRegisteredPaths } from "./update-candidate-state.shared.js";

/**
 * Main builds from #199706 (6747b1ec5ae, 2026-11-17) up to #201917 (2ef6f7bade7) build a Git
 * release in `<stateDir>/git-install/releases/<id>/build` behind the link
 * `git-install/lib/node_modules/openclaw`, and run this check there. No other updater builds a
 * release at that path. Those before #201463 (2183caf789c) then refuse, before restarting the
 * Gateway, unless state is already at the versions this check reports; but on that route the
 * Gateway that starts from the release is what migrates state. Reporting the versions on disk
 * lets that updater restart into the release, which migrates at boot. Later updaters in the
 * window skip that comparison, so the answer changes nothing for them.
 *
 * Returns null for every other caller and when the stores disagree.
 *
 * Remove once no install can still run an updater built from that window (installs that never
 * updated past 2026-11-19 main).
 */
export function readEarlyGitReleaseDriverStateVersions(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): OpenClawSchemaVersions | null {
  const releases = path.dirname(path.dirname(root));
  const prefix = path.join(resolveStateDir(env), "git-install");
  if (
    path.basename(root) !== "build" ||
    path.basename(releases) !== "releases" ||
    path.resolve(path.dirname(releases)) !== path.resolve(prefix) ||
    !fs.lstatSync(path.join(prefix, "lib", "node_modules", "openclaw"), {
      throwIfNoEntry: false,
    })?.isSymbolicLink()
  ) {
    return null;
  }
  try {
    const shared = resolveOpenClawStateSqlitePath(env);
    const agentPaths = new Set<string>();
    let state: number;
    const db = openNodeSqliteDatabase(shared, { readOnly: true });
    try {
      state = readStateSchemaContentVersion(db);
      for (const { source } of collectRegisteredPaths(db, shared, new Map())) {
        agentPaths.add(source);
      }
    } finally {
      db.close();
    }
    const agents = new Set<number>();
    for (const file of agentPaths) {
      if (!fs.existsSync(file)) {
        continue;
      }
      const agent = openNodeSqliteDatabase(file, { readOnly: true });
      try {
        agents.add(readSqliteUserVersion(agent));
      } finally {
        agent.close();
      }
    }
    if (agents.size > 1) {
      return null;
    }
    return { state, agent: [...agents][0] ?? OPENCLAW_AGENT_SCHEMA_VERSION };
  } catch {
    return null;
  }
}
