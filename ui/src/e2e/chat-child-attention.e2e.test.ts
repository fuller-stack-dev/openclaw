import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat child attention" });

suite.define(() => {
  it.each([
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ])("aligns a blocked child notice with its parent's composer at $width px", async (viewport) => {
    await suite.withPage({ viewport, locale: "en-US" }, async ({ page }) => {
      const now = Date.now();
      const parent = {
        key: "agent:main:dashboard:diagnostic-parent",
        sessionId: "diagnostic-parent",
        kind: "direct",
        label: "Messaging channel setup",
        status: "done",
        hasActiveRun: false,
        updatedAt: now,
        childSessions: ["agent:main:subagent:debugger"],
      } satisfies GatewaySessionRow;
      const child = {
        key: parent.childSessions![0]!,
        sessionId: "debugger-child",
        kind: "direct",
        classification: "subagent",
        label: "Debugger diagnostic",
        spawnedBy: parent.key,
        parentSessionKey: parent.key,
        status: "done",
        hasActiveRun: false,
        updatedAt: now,
        endedAt: now,
        unread: true,
        agentStatus: {
          note: "Blocked: debugger attempt expired; no attach or visible prompt verified. Inspect the target device before another debugger attempt.",
          attention: "key",
          expiresAt: now + 60_000,
        },
      } satisfies GatewaySessionRow;
      await installMockGateway(page, {
        sessionKey: parent.key,
        sessions: [parent, child],
        communityInvite: false,
        historyMessages: [
          { role: "assistant", content: "The diagnostic has resumed. Waiting for its result." },
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
      const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
      await pane
        .getByText("The diagnostic has resumed. Waiting for its result.", { exact: true })
        .waitFor();
      const notice = pane.locator(".chat-child-attention");
      const composer = pane.locator(".agent-chat__input");
      try {
        await notice.waitFor();
        expect(await notice.textContent()).toContain(child.agentStatus!.note);
        expect(await notice.getAttribute("data-child-session-key")).toBe(child.key);
        expect(
          await notice
            .locator(".chat-composer-neighbor-card__copy span")
            .evaluate((node) => getComputedStyle(node).whiteSpace),
        ).toBe("normal");
        await notice
          .getByRole("button", { name: "Open session", exact: true })
          .click({ trial: true });
        const noticeBox = await notice.boundingBox();
        const composerBox = await composer.boundingBox();
        expect(noticeBox).not.toBeNull();
        expect(composerBox).not.toBeNull();
        expect(noticeBox!.x).toBeCloseTo(composerBox!.x, 0);
        expect(noticeBox!.width).toBeCloseTo(composerBox!.width, 0);
        // The compact mobile input is a capsule; its neighboring notice retains
        // the reading card radius while sharing the same column.
        expect(await notice.evaluate((node) => getComputedStyle(node).borderRadius)).toBe("25px");
        expect(await composer.evaluate((node) => getComputedStyle(node).borderRadius)).toBe(
          viewport.width === 390 ? "35px" : "25px",
        );
      } finally {
        if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
          const frame = await takeControlUiScreenshotFrame(
            page,
            pane,
            [
              pane.getByText("The diagnostic has resumed. Waiting for its result.", {
                exact: true,
              }),
              ...((await notice.isVisible()) ? [notice] : []),
              composer,
            ],
            { animations: "disabled" },
          );
          await writeFile(
            path.join(suite.artifactDir, `child-attention-${viewport.width}.png`),
            frame.png,
          );
        }
      }
    });
  });

  it("dismisses failed children through their Gateway read state", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const now = Date.now();
        const parentKey = "agent:main:dashboard:failed-children-parent";
        const failed = (id: string, label: string) =>
          ({
            key: `agent:main:subagent:${id}`,
            sessionId: id,
            kind: "direct",
            classification: "subagent",
            label,
            spawnedBy: parentKey,
            parentSessionKey: parentKey,
            status: "failed",
            hasActiveRun: false,
            updatedAt: now,
            endedAt: now,
            unread: true,
            lastRunError: `${label} failed`,
          }) satisfies GatewaySessionRow;
        const children = [
          failed("first-failure", "First diagnostic"),
          failed("second-failure", "Second diagnostic"),
          failed("third-failure", "Third diagnostic"),
        ];
        const parent = {
          key: parentKey,
          sessionId: "failed-children-parent",
          kind: "direct",
          status: "done",
          hasActiveRun: false,
          updatedAt: now,
          childSessions: children.map((child) => child.key),
        } satisfies GatewaySessionRow;
        const gateway = await installMockGateway(page, {
          sessionKey: parent.key,
          sessions: [parent, ...children],
          communityInvite: false,
          historyMessages: [{ role: "assistant", content: "Diagnostics finished." }],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
        const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        await pane.getByText("Diagnostics finished.", { exact: true }).waitFor();
        const cards = pane.locator(".chat-child-attention");
        await expect.poll(() => cards.count()).toBe(3);
        const first = pane.locator(`[data-child-session-key="${children[0]!.key}"]`);
        const dismissFirst = first.getByRole("button", {
          name: "Dismiss failure for First diagnostic",
          exact: true,
        });

        // A rejected read leaves the card and reports why.
        const patchesBefore = (await gateway.getRequests("sessions.patch")).length;
        await gateway.deferNext("sessions.patch");
        await dismissFirst.click();
        const rejected = await gateway.waitForRequest("sessions.patch", { after: patchesBefore });
        expect(rejected.params).toMatchObject({ key: children[0]!.key, unread: false });
        await gateway.rejectDeferred("sessions.patch", {
          code: "UNAVAILABLE",
          message: "Session store busy",
        });
        await expect
          .poll(() => first.textContent())
          .toContain("Couldn't dismiss: Session store busy");
        expect(await cards.count()).toBe(3);

        // The retry records the read at the Gateway, which retires the card.
        await dismissFirst.click();
        await expect.poll(() => first.count()).toBe(0);
        expect((await gateway.getSessionRow(children[0]!.key)).lastReadAt).toBeGreaterThan(0);

        await pane
          .getByRole("button", { name: "Dismiss all failed child sessions shown", exact: true })
          .click();
        await expect.poll(() => cards.count()).toBe(0);
        for (const child of children.slice(1)) {
          expect((await gateway.getSessionRow(child.key)).lastReadAt).toBeGreaterThan(0);
        }
      },
    );
  });

  it("never flashes a child the parent's child query no longer links", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const parent = {
        key: "agent:main:dashboard:expired-parent",
        sessionId: "expired-parent",
        kind: "direct",
        status: "done",
        updatedAt: Date.now(),
      } satisfies GatewaySessionRow;
      // The broad roster keeps spawnedBy after the Gateway retires the child link.
      const expired = {
        key: "agent:main:subagent:expired",
        sessionId: "expired-child",
        kind: "direct",
        classification: "subagent",
        label: "Expired diagnostic",
        spawnedBy: parent.key,
        status: "timeout",
        updatedAt: 1,
        endedAt: 1,
      } satisfies GatewaySessionRow;
      await page.addInitScript(() => {
        const seen = { flashed: false };
        Object.assign(window, { childAttentionSeen: seen });
        new MutationObserver(() => {
          seen.flashed ||= document.querySelector(".chat-child-attention") !== null;
        }).observe(document, { childList: true, subtree: true });
      });
      const gateway = await installMockGateway(page, {
        sessionKey: parent.key,
        sessions: [parent, expired],
        communityInvite: false,
        historyMessages: [{ role: "assistant", content: "Parent history loaded." }],
        methodResponses: {
          "sessions.list": {
            cases: [
              { match: { spawnedBy: parent.key }, response: sessionsListResponse([]) },
              { response: sessionsListResponse([parent, expired]) },
            ],
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
      const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
      await pane.getByText("Parent history loaded.", { exact: true }).waitFor();
      await gateway.waitForRequest("sessions.list", { match: { spawnedBy: parent.key } });
      await expect.poll(() => pane.locator("openclaw-chat-child-attention").count()).toBe(1);
      expect(
        await page.evaluate(
          () => (window as { childAttentionSeen?: { flashed: boolean } }).childAttentionSeen,
        ),
      ).toEqual({ flashed: false });
    });
  });
});
