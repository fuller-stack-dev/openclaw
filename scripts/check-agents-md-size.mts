#!/usr/bin/env node
// Keeps tracked AGENTS.md files under the workspace bootstrap cap. Above it,
// OpenClaw injects only a head, a policy digest and a tail, so agents miss rules.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolveBootstrapMaxChars } from "../src/agents/embedded-agent-helpers/bootstrap.ts";

const maxChars = resolveBootstrapMaxChars();
const files = execFileSync("git", ["ls-files", "-z", "--", "AGENTS.md", "*/AGENTS.md"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

let failed = false;
for (const file of files) {
  // The bootstrap trimmer measures UTF-16 length, so match String#length.
  const chars = readFileSync(file, "utf8").length;
  if (chars > maxChars) {
    failed = true;
    console.error(
      `${file}: ${chars} chars exceeds the ${maxChars}-char workspace bootstrap cap by ${chars - maxChars}. ` +
        "Cut rules, or move subsystem rules to the owning scoped AGENTS.md.",
    );
  }
}
if (failed) {
  process.exitCode = 1;
} else {
  console.log(`AGENTS.md size check: ${files.length} files within ${maxChars} chars.`);
}
