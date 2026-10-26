import { afterEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
/* @vitest-environment jsdom */
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { renderChatComposerNotices } from "../chat-view-notices.tsx";

const parentKey = "agent:main:dashboard:parent";
const childKey = "agent:main:subagent:diagnostic";
const now = 10_000;
const child: GatewaySessionRow = {
  key: childKey,
  kind: "direct",
  label: "Debugger diagnostic",
  spawnedBy: parentKey,
  status: "done",
  endedAt: now,
  agentStatus: {
    note: "Blocked: debugger attempt expired; no attach or visible prompt verified.",
    attention: "key",
    expiresAt: now + 60_000,
  },
};

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

function mount(
  rows: GatewaySessionRow[] = [child],
  failureDismissal?: Parameters<typeof renderChatComposerNotices>[0]["childFailureDismissal"],
) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const container = document.body.appendChild(document.createElement("div"));
  const open = vi.fn();
  // Reproduce the parent entry point: no run error or new assistant message.
  let props: Parameters<typeof renderChatComposerNotices>[0] = {
    sessionKey: parentKey,
    subagentParentKey: parentKey,
    messages: [{ role: "assistant", content: "The diagnostic is running." }],
    subagentSessions: rows,
    subagentSessionsRead: true,
    onOpenSubagent: open,
    childFailureDismissal: failureDismissal,
  };
  const view = mountSolid(renderChatComposerNotices, props, container);
  const notice = container.querySelector<HTMLElement>("openclaw-chat-child-attention");
  expect(notice).not.toBeNull();
  return {
    container,
    open,
    notice: notice!,
    unmount: view.dispose,
    update(this: void, changes: Partial<typeof props>) {
      props = { ...props, ...changes };
      view.update(props);
    },
  };
}

it("shows the blocked child outcome in its idle parent and opens that exact child", async () => {
  const { container, open } = mount();
  flush();
  const card = container.querySelector(".chat-child-attention");
  expect(card?.getAttribute("role")).toBe("status");
  expect(card?.textContent).toContain(child.label);
  expect(card?.textContent).toContain(child.agentStatus!.note);
  expect(card?.querySelector("details")).toBeNull();
  card?.querySelector<HTMLButtonElement>("button")?.click();
  expect(open).toHaveBeenCalledExactlyOnceWith(childKey);
});

it.each(["failed", "timeout"] as const)(
  "shows an unread %s child diagnostic and clears after acknowledgement",
  async (status) => {
    const failed = {
      ...child,
      status,
      agentStatus: undefined,
      lastRunError: "Diagnostic failed <img src=x>",
    };
    const { notice, update } = mount([failed]);
    flush();
    expect(notice.querySelector('[role="alert"]')?.textContent).toContain(failed.lastRunError);
    expect(notice.querySelector("img")).toBeNull();
    update({ subagentSessions: [{ ...failed, suppressErrorNotice: true }] });
    flush();
    expect(notice.querySelector(".chat-child-attention")).toBeNull();
    update({ subagentSessions: [failed] });
    flush();
    expect(notice.querySelector('[role="alert"]')?.textContent).toContain(failed.lastRunError);
    update({ subagentSessions: [{ ...failed, lastReadAt: now }] });
    flush();
    expect(notice.querySelector(".chat-child-attention")).toBeNull();
  },
);

it("reconciles cleared notes, expiry, and changed parent without retaining stale blockers", async () => {
  const { notice, update } = mount();
  flush();
  update({ subagentSessions: [{ ...child, agentStatus: undefined }] });
  flush();
  expect(notice.querySelector(".chat-child-attention")).toBeNull();
  update({ subagentSessions: [child] });
  flush();
  update({ subagentParentKey: "agent:main:dashboard:other" });
  flush();
  expect(notice.querySelector(".chat-child-attention")).toBeNull();
  update({ subagentParentKey: parentKey });
  flush();
  expect(notice.querySelector(".chat-child-attention")).not.toBeNull();
  await vi.advanceTimersByTimeAsync(60_001);
  flush();
  expect(notice.querySelector(".chat-child-attention")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("uses sidebar ancestry for nested outcomes and excludes unrelated or archived branches", async () => {
  const intermediate: GatewaySessionRow = {
    key: "agent:main:subagent:coordinator",
    kind: "direct",
    spawnedBy: parentKey,
  };
  const nested = { ...child, spawnedBy: intermediate.key };
  const { notice, update } = mount([
    intermediate,
    nested,
    { ...child, key: "agent:main:subagent:other", spawnedBy: "agent:main:other" },
    { ...child, key: "agent:main:subagent:archived", archived: true },
  ]);
  flush();
  expect(
    [...notice.querySelectorAll("[data-child-session-key]")].map((node) =>
      node.getAttribute("data-child-session-key"),
    ),
  ).toEqual([childKey]);
  update({ subagentSessions: [{ ...intermediate, archived: true }, nested] });
  flush();
  expect(notice.querySelector(".chat-child-attention")).toBeNull();
});

it("retires its expiry timer when the pane is removed", async () => {
  const { unmount } = mount();
  flush();
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
});

function failedChild(id: string, label: string): GatewaySessionRow {
  return {
    ...child,
    key: `agent:main:subagent:${id}`,
    label,
    status: "failed",
    endedAt: now,
    agentStatus: undefined,
    lastRunError: `${label} failed`,
  };
}

/** Records Gateway read writes and lets each test decide the outcome. */
function gatewayReads() {
  const writes: Array<{
    key: string;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  return {
    writes,
    dismissal: {
      canDismiss: (row: GatewaySessionRow) => row.sharingRole !== "viewer",
      dismiss: (row: GatewaySessionRow) =>
        new Promise<void>((resolve, reject) => {
          writes.push({ key: row.key, resolve, reject });
        }),
    },
  };
}

function cardFor(notice: HTMLElement, key: string) {
  return notice.querySelector<HTMLElement>(`[data-child-session-key="${key}"]`);
}

function dismissButton(notice: HTMLElement, label: string) {
  return notice.querySelector<HTMLButtonElement>(
    `button[aria-label="Dismiss failure for ${label}"]`,
  );
}

const dismissAllLabel = "Dismiss all failed child sessions shown";

it("dismisses one failed child through its Gateway read and keeps blocked notes", async () => {
  const failed = failedChild("first", "First diagnostic");
  const viewer = { ...failedChild("shared", "Shared diagnostic"), sharingRole: "viewer" as const };
  const reads = gatewayReads();
  const { notice, update } = mount([child, failed, viewer], reads.dismissal);
  flush();
  // Only failures the caller may mark read get an X; agent notes keep their own lifecycle.
  expect(dismissButton(notice, child.label!)).toBeNull();
  expect(dismissButton(notice, viewer.label!)).toBeNull();
  expect(notice.querySelector(`button[aria-label="${dismissAllLabel}"]`)).toBeNull();

  dismissButton(notice, failed.label!)!.click();
  flush();
  expect(reads.writes.map((write) => write.key)).toEqual([failed.key]);
  expect(dismissButton(notice, failed.label!)?.disabled).toBe(true);
  // The card waits for the Gateway's row instead of hiding on the request alone.
  reads.writes[0]!.resolve();
  await Promise.resolve();
  flush();
  expect(cardFor(notice, failed.key)).not.toBeNull();

  update({ subagentSessions: [child, { ...failed, lastReadAt: now + 1 }, viewer] });
  flush();
  expect(cardFor(notice, failed.key)).toBeNull();
  expect(cardFor(notice, childKey)?.textContent).toContain(child.agentStatus!.note);
  expect(cardFor(notice, viewer.key)).not.toBeNull();
});

it("dismisses every failed child shown with Dismiss all", async () => {
  const first = failedChild("first", "First diagnostic");
  const second = { ...failedChild("second", "Second diagnostic"), status: "timeout" as const };
  const third = failedChild("third", "Third diagnostic");
  const reads = gatewayReads();
  const { notice, update } = mount([child, first, second, third], reads.dismissal);
  flush();
  const dismissAll = notice.querySelector<HTMLButtonElement>(
    `button[aria-label="${dismissAllLabel}"]`,
  );
  expect(dismissAll?.textContent?.trim()).toBe("Dismiss all");
  dismissAll!.click();
  flush();
  expect(reads.writes.map((write) => write.key)).toEqual([first.key, second.key, third.key]);
  expect(dismissAll!.disabled).toBe(true);
  for (const write of reads.writes) {
    write.resolve();
  }
  await Promise.resolve();
  update({
    subagentSessions: [child, first, second, third].map((row) =>
      row === child ? row : Object.assign({}, row, { lastReadAt: now + 1 }),
    ),
  });
  flush();
  expect(
    [...notice.querySelectorAll("[data-child-session-key]")].map((node) =>
      node.getAttribute("data-child-session-key"),
    ),
  ).toEqual([childKey]);
  expect(notice.querySelector(`button[aria-label="${dismissAllLabel}"]`)).toBeNull();
});

it("shows a failure that ends after the dismissal as a new card", async () => {
  const failed = failedChild("first", "First diagnostic");
  const reads = gatewayReads();
  const { notice, update } = mount([failed], reads.dismissal);
  flush();
  dismissButton(notice, failed.label!)!.click();
  reads.writes[0]!.resolve();
  await Promise.resolve();
  update({ subagentSessions: [{ ...failed, lastReadAt: now + 1 }] });
  flush();
  expect(cardFor(notice, failed.key)).toBeNull();

  const later = { ...failed, lastReadAt: now + 1, endedAt: now + 5, lastRunError: "Retry failed" };
  update({ subagentSessions: [later] });
  flush();
  expect(cardFor(notice, failed.key)?.textContent).toContain("Retry failed");
  const again = dismissButton(notice, failed.label!);
  expect(again?.disabled).toBe(false);
  again!.click();
  expect(reads.writes.map((write) => write.key)).toEqual([failed.key, failed.key]);
});

it("keeps a failed child visible with the error when its read is rejected", async () => {
  const failed = failedChild("first", "First diagnostic");
  const other = failedChild("second", "Second diagnostic");
  const reads = gatewayReads();
  const { notice, update } = mount([failed, other], reads.dismissal);
  flush();
  notice.querySelector<HTMLButtonElement>(`button[aria-label="${dismissAllLabel}"]`)!.click();
  reads.writes[0]!.reject(new Error("Session store busy"));
  reads.writes[1]!.resolve();
  await Promise.resolve();
  await Promise.resolve();
  update({ subagentSessions: [failed, { ...other, lastReadAt: now + 1 }] });
  flush();
  const card = cardFor(notice, failed.key);
  expect(card?.getAttribute("role")).toBe("alert");
  expect(card?.textContent).toContain(failed.lastRunError);
  expect(card?.textContent).toContain("Couldn't dismiss: Session store busy");
  expect(cardFor(notice, other.key)).toBeNull();

  // Retrying clears the stale error while the new write is outstanding.
  const retry = dismissButton(notice, failed.label!);
  expect(retry?.disabled).toBe(false);
  retry!.click();
  flush();
  expect(reads.writes.map((write) => write.key)).toEqual([failed.key, other.key, failed.key]);
  expect(card?.textContent).not.toContain("Couldn't dismiss");
});
