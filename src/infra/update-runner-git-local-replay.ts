import { DEV_BRANCH } from "./update-channels.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import { UPDATE_PREFLIGHT_REBASE_TIMEOUT_MS } from "./update-run-timeouts.js";
import { reportUpdateStepCompletion } from "./update-runner-command.js";
import { classifyPreflightFailure, type StepFactory } from "./update-runner-git-commands.js";
import { runClassifiedGitStep } from "./update-runner-git-steps.js";
import type { CommandRunner, RunStepOptions } from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

// Deployment checkouts carry small patch stacks. More means Git cannot see the shared history.
const MAX_LOCAL_REPLAY_COMMITS = 1000;

/**
 * Explain why replaying local commits onto a target would not be meaningful, before Git
 * starts. A shallow boundary can hide a real ancestor, leaving history that looks unpublished
 * and can run to hundreds of thousands of commits with a lazy blob fetch per comparison.
 * Accepted edge: a small hidden range still replays; a conflict or the deadline bounds it.
 */
export async function readLocalReplayObstacle(
  params: { gitRoot: string; runCommand: CommandRunner; timeoutMs: number },
  source: string,
  target: string,
): Promise<string | undefined> {
  const runGit = (args: string[]) =>
    params.runCommand(["git", "-C", params.gitRoot, "--no-lazy-fetch", ...args], {
      cwd: params.gitRoot,
      timeoutMs: params.timeoutMs,
    });
  const base = await runGit(["merge-base", source, target]);
  if (base.code === 1) {
    return `Git sees no history it shares with ${target} (a shallow boundary or unrelated history)`;
  }
  const count =
    base.code === 0 ? await runGit(["rev-list", "--count", `${target}..${source}`]) : undefined;
  const commits = count?.code === 0 ? Number(count.stdout.trim()) : Number.NaN;
  if (!Number.isSafeInteger(commits)) {
    return `Git could not read its relation to ${target}`;
  }
  return commits > MAX_LOCAL_REPLAY_COMMITS
    ? `Git counts ${commits} commits to replay onto ${target}, more than the ${MAX_LOCAL_REPLAY_COMMITS} an update replays`
    : undefined;
}

export type LocalReplayFailure = {
  status: "replay-failed";
  ending: "conflict" | "expired" | "interrupted";
};

/** Replay local commits onto the checked-out candidate; returns how a failed replay ended. */
export async function replayLocalCommits(params: {
  worktreeDir: string;
  source: string;
  target: string;
  referenceSource?: object;
  workStep: StepFactory;
  step: StepFactory;
  runCheck: (
    name: string,
    argv: string[],
    env: NodeJS.ProcessEnv | undefined,
    factory: StepFactory,
  ) => Promise<UpdateStepResult | null>;
}): Promise<LocalReplayFailure | { status: "failed" | "insufficient-space" } | undefined> {
  const git = ["git", "-C", params.worktreeDir];
  // Unlike required work, replay has a safe fallback, so it never runs without a deadline.
  const replayStep: StepFactory = (...args) => {
    const options = params.workStep(...args);
    return {
      ...options,
      timeoutMs: Math.min(options.timeoutMs ?? Infinity, UPDATE_PREFLIGHT_REBASE_TIMEOUT_MS),
    };
  };
  const failed =
    (await params.runCheck(
      "local-checkout",
      [...git, "checkout", "--detach", params.source],
      undefined,
      replayStep,
    )) ??
    (await params.runCheck(
      "rebase",
      [...git, "rebase", ...(params.referenceSource ? ["--rebase-merges"] : []), params.target],
      undefined,
      replayStep,
    ));
  if (!failed) {
    return undefined;
  }
  await params.runCheck("rebase-abort", [...git, "rebase", "--abort"], undefined, params.step);
  const failure = classifyPreflightFailure(failed);
  if (failure !== "failed") {
    return { status: failure };
  }
  if (failed.termination === "signal" || failed.exitCode === 130 || failed.exitCode === 143) {
    return { status: "replay-failed", ending: "interrupted" };
  }
  // Reference builds exist to consume operator source, so they have no clean alternative.
  if (params.referenceSource) {
    return { status: "failed" };
  }
  const expired = failed.termination === "timeout" || failed.termination === "no-output-timeout";
  return { status: "replay-failed", ending: expired ? "expired" : "conflict" };
}

export async function reportLocalReplayWarning(
  options: RunStepOptions,
  source: string,
  reason: string,
): Promise<void> {
  const warning: UpdateStepResult = {
    name: options.name,
    command: `git rebase (local ${DEV_BRANCH} ${source})`,
    cwd: options.cwd,
    durationMs: 0,
    exitCode: 0,
    advisory: {
      kind: "recoverable-maintenance",
      message: `Validating this update without local ${DEV_BRANCH} ${source}: ${reason}. Activation keeps any commits this leaves out.`,
    },
  };
  options.results?.push(warning);
  await reportUpdateStepCompletion(options.progress, {
    ...warning,
    index: options.stepIndex,
    total: options.totalSteps,
  });
}

/**
 * `checkout -B` moves the dev branch without looking at what it leaves behind. Keep commits
 * the candidate does not carry under a ref first, or else leave the branch where it is.
 * A replay carries plain commits, so rewriting them needs no extra ref, but it flattens
 * merges and can lose edits recorded only in them.
 */
export async function resolveGitActivationCheckout(params: {
  gitRoot: string;
  candidateSha: string;
  replayedLocalSha: string | null;
  activateBranch: boolean;
  step: (name: string, argv: string[], cwd: string) => RunStepOptions;
}): Promise<string[]> {
  const { gitRoot, candidateSha } = params;
  const git = ["git", "-C", gitRoot];
  const detached = [...git, "checkout", "--detach", candidateSha];
  if (!params.activateBranch) {
    return detached;
  }
  const moved = [...git, "checkout", "-B", DEV_BRANCH, candidateSha];
  const options = params.step("git-preserve-local-branch", [], gitRoot);
  const probe = (...args: string[]) =>
    options.runCommand([...git, "--no-lazy-fetch", ...args], {
      cwd: gitRoot,
      timeoutMs: options.timeoutMs,
    });
  const branch = await probe("rev-parse", "--verify", "--quiet", `refs/heads/${DEV_BRANCH}`);
  if (branch.code !== 0) {
    // Exit 1 means no branch exists; anything else leaves its commits unknown.
    return branch.code === 1 ? moved : detached;
  }
  const sha = branch.stdout.trim();
  const carried =
    sha === params.replayedLocalSha
      ? (
          await probe("rev-list", "--count", "--merges", `${candidateSha}..${sha}`)
        ).stdout.trim() === "0"
      : (await probe("merge-base", "--is-ancestor", sha, candidateSha)).code === 0;
  if (carried) {
    return moved;
  }
  const ref = `refs/openclaw/update-preserved/${DEV_BRANCH}-${sha}`;
  return runClassifiedGitStep({ ...options, argv: [...git, "update-ref", ref, sha] }, (result) => {
    const preserved = !isFailedUpdateStep(result);
    result.advisory = {
      kind: "recoverable-maintenance",
      message: preserved
        ? `Local ${DEV_BRANCH} ${sha} is not fully part of this update, so it is preserved at ${ref} and ${DEV_BRANCH} moves to ${candidateSha}. If it held local work, review it with: git -C ${gitRoot} log ${candidateSha}..${ref}. Remove the ref with git update-ref -d once it is no longer needed.`
        : `Could not preserve local ${DEV_BRANCH} ${sha} at ${ref}, so ${DEV_BRANCH} stays where it is and this update activates on a detached HEAD. ${result.stderrTail ?? ""}`,
    };
    return preserved ? moved : detached;
  });
}
