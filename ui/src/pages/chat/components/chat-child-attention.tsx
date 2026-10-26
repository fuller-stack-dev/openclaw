import { For, Show, createMemo, createSignal } from "solid-js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { collectSessionDescendantRows } from "../../../components/app-sidebar-session-parent.ts";
import { formatWebUiIconErrorText } from "../../../components/error-presentation.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { formatUiError } from "../../../lib/format-error.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { createInterval } from "../../../lib/reactive/timers.ts";
import { sessionRowAttention } from "../../../lib/session-attention.ts";
import { resolveSessionDisplayName } from "../../../lib/session-display.ts";
import { isSubagentsPanelSession } from "../chat-spawned-subagent.ts";

/**
 * Acknowledges a child failure in the Gateway's read state, so every device
 * stops showing it. A later failure ends after that read and shows again.
 */
export type ChildFailureDismissal = {
  canDismiss: (row: GatewaySessionRow) => boolean;
  dismiss: (row: GatewaySessionRow) => Promise<void>;
};

type Props = {
  sessions: readonly GatewaySessionRow[];
  sessionKey: string;
  onOpenSubagent: ((key: string) => void) | undefined;
  onOpenSession: ((key: string) => void) | undefined;
  failureDismissal?: ChildFailureDismissal;
};
const attentionIcons = {
  hand: "hand",
  key: "key",
  alert: "alertTriangle",
  flag: "flag",
  lock: "lock",
  hourglass: "circle",
} as const;

/** One failure episode; a later failure of the same child is a new card. */
function failureIdentity(row: GatewaySessionRow): string {
  return JSON.stringify([row.key, row.endedAt ?? row.updatedAt ?? 0]);
}

/** Child status is a recorded outcome, even when its parent has no new reply. */
export function ChatChildAttention(props: Props) {
  const [clock, setClock] = createSignal(0);
  const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = createSignal<ReadonlyMap<string, string>>(new Map());
  const rows = createMemo(() => {
    clock();
    const now = Date.now();
    return collectSessionDescendantRows(props.sessions, props.sessionKey).flatMap((row) => {
      const attention = sessionRowAttention(row, now);
      return attention.kind === "none" ? [] : [{ row, attention }];
    });
  });
  const dismissible = createMemo(() =>
    rows().flatMap(({ row, attention }) =>
      attention.kind === "error" && props.failureDismissal?.canDismiss(row) ? [row] : [],
    ),
  );
  const settle = (identity: string, error?: string) => {
    setPending((current) => {
      const next = new Set(current);
      next.delete(identity);
      return next;
    });
    if (error !== undefined) {
      setErrors((current) => new Map(current).set(identity, error));
    }
  };
  const dismiss = (targets: readonly GatewaySessionRow[]) => {
    const dismissal = props.failureDismissal;
    const busy = pending();
    const started = targets.filter((row) => !busy.has(failureIdentity(row)));
    if (!dismissal || started.length === 0) {
      return;
    }
    const identities = started.map(failureIdentity);
    setPending((current) => new Set([...current, ...identities]));
    setErrors((current) => {
      const next = new Map(current);
      for (const identity of identities) {
        next.delete(identity);
      }
      return next;
    });
    started.forEach((row, index) => {
      const identity = identities[index]!;
      // The card stays until the Gateway's row reports the read.
      void dismissal.dismiss(row).then(
        () => settle(identity),
        (error: unknown) =>
          settle(identity, formatUiError(error, t("chat.childAttention.dismissFailedUnknown"))),
      );
    });
  };
  createInterval(
    () => setClock((value) => value + 1),
    () => {
      const expiry = Math.min(
        ...rows().flatMap(({ row, attention }) =>
          attention.kind === "agent" && row.agentStatus ? [row.agentStatus.expiresAt] : [],
        ),
      );
      return Number.isFinite(expiry) ? Math.max(0, expiry - Date.now() + 1) : undefined;
    },
  );
  return (
    <openclaw-chat-child-attention style={{ display: "contents" }}>
      <Show when={dismissible().length > 1}>
        <div class="chat-child-attention__toolbar">
          <button
            class="btn btn--sm"
            type="button"
            aria-label={t("chat.childAttention.dismissAllLabel")}
            disabled={dismissible().every((row) => pending().has(failureIdentity(row)))}
            onClick={() => dismiss(dismissible())}
          >
            {t("chat.childAttention.dismissAll")}
          </button>
        </div>
      </Show>
      <For each={rows()} keyed={(item) => item.row.key}>
        {(item) => {
          const open = () =>
            isSubagentsPanelSession(item().row)
              ? (props.onOpenSubagent ?? props.onOpenSession)
              : props.onOpenSession;
          const note = () => {
            const attention = item().attention;
            return attention.kind === "agent" ? attention.note : attention.reason;
          };
          const icon = () => {
            const attention = item().attention;
            return attention.kind === "agent" ? attentionIcons[attention.icon] : "alertTriangle";
          };
          const canDismiss = () => dismissible().includes(item().row);
          const identity = () => failureIdentity(item().row);
          const label = () => resolveSessionDisplayName(item().row.key, item().row);
          return (
            <div
              class={[
                "chat-composer-neighbor-card",
                "chat-child-attention",
                {
                  "chat-composer-neighbor-card--warn": item().attention.kind === "agent",
                  "chat-composer-neighbor-card--danger": item().attention.kind !== "agent",
                  "chat-child-attention--dismissible": canDismiss(),
                },
              ]}
              data-child-session-key={item().row.key}
              role={item().attention.kind === "agent" ? "status" : "alert"}
            >
              <span class="chat-composer-neighbor-card__icon" aria-hidden="true">
                <Icon name={icon()} />
              </span>
              <div class="chat-composer-neighbor-card__copy">
                <strong>{label()}</strong>
                <span>{formatWebUiIconErrorText(note())}</span>
                <Show when={canDismiss() && errors().get(identity())}>
                  {(error) => (
                    <span class="chat-child-attention__dismiss-error">
                      {t("chat.childAttention.dismissFailed", { error: error() })}
                    </span>
                  )}
                </Show>
              </div>
              {open() && (
                <button class="btn btn--sm" type="button" onClick={() => open()?.(item().row.key)}>
                  {t("sessionsView.openSession")}
                </button>
              )}
              <Show when={canDismiss()}>
                <button
                  class="chat-error__dismiss"
                  type="button"
                  aria-label={t("chat.childAttention.dismiss", { session: label() })}
                  disabled={pending().has(identity())}
                  onClick={() => dismiss([item().row])}
                >
                  <Icon name="x" />
                </button>
              </Show>
            </div>
          );
        }}
      </For>
    </openclaw-chat-child-attention>
  );
}
