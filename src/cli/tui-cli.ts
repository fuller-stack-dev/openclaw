// Experimental replacement for the native TUI: render the Control UI in the terminal.
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime } from "../runtime.js";

type TuiCliOptions = {
  yes?: boolean;
};

export async function runTuiCliAction(
  _target: string | undefined,
  opts: TuiCliOptions,
  _invokedSubcommand = "tui",
): Promise<void> {
  const { dashboardCommand } = await import("../commands/dashboard.js");
  await dashboardCommand(defaultRuntime, {
    terminal: true,
    yes: Boolean(opts.yes),
  });
}

/** Attach the terminal-rendered Control UI to the root CLI. */
export function registerTuiCli(program: Command) {
  program
    .command("tui")
    .alias("terminal")
    .alias("chat")
    .description("Open the Control UI inside the current terminal")
    .option("--yes", "Start or install the Gateway without prompting when needed", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Experimental:")} renders the Control UI with terminal-browser app mode.\n${theme.muted("Docs:")} ${formatDocsLink("/web/control-ui", "docs.openclaw.ai/web/control-ui")}\n`,
    )
    .action(async (opts: TuiCliOptions) => {
      try {
        await runTuiCliAction(undefined, opts);
      } catch (err) {
        defaultRuntime.error(formatErrorMessage(err));
        defaultRuntime.exit(1);
      }
    });
}
