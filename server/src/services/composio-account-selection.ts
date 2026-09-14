import type { ComposioConnectedAccount } from "./composio.js";

/**
 * Picks the Composio connected account a Paperclip child connection should use.
 *
 * A child pins one `connectedAccountId`. Reconnecting a toolkit directly in the
 * Composio dashboard does not refresh that account: Composio creates a NEW
 * account with a new id and leaves the old one EXPIRED (or deletes it). The pin
 * then keeps pointing at a dead account, the child degrades, and its tools vanish
 * from agent discovery even though Composio shows the toolkit as connected. Only
 * a reconnect through Paperclip's own connect dialog used to move the pin.
 *
 * This selection lets the health check and the parent resume path follow such a
 * reconnect on their own - but only when the replacement is unambiguous and
 * cannot widen access:
 *
 * - The pinned account still exists (e.g. EXPIRED): the replacement must use the
 *   SAME auth config. A different auth config can carry different scopes (e.g.
 *   Composio's managed GitHub app with `repo`/`workflow` on every repository
 *   instead of a narrowly installed custom GitHub App), so silently switching to
 *   it would be a privilege change nobody approved.
 * - The pinned account is gone: its auth config is unknown, so exactly one
 *   active account for the toolkit must exist. Several candidates mean a human
 *   has to choose; guessing could bind the wrong credentials.
 *
 * Disabled accounts and accounts of other toolkits never qualify. Children
 * without a pin (created before pinning existed) keep their old behaviour.
 */
export type ComposioAccountSelection =
  | { kind: "pinned_active"; account: ComposioConnectedAccount }
  | {
      kind: "rebind";
      account: ComposioConnectedAccount;
      previousAccountId: string | null;
      previousStatus: string;
    }
  | {
      kind: "unavailable";
      pinnedStatus: string;
      reason: "no_active_account" | "ambiguous" | "auth_config_mismatch";
    };

function isActive(account: ComposioConnectedAccount): boolean {
  return account.status.trim().toUpperCase() === "ACTIVE" && account.is_disabled !== true;
}

export function selectComposioAccountForChild(input: {
  accounts: ComposioConnectedAccount[];
  toolkitSlug: string;
  pinnedAccountId: string | null | undefined;
}): ComposioAccountSelection {
  const toolkitAccounts = input.accounts.filter(
    (account) => account.toolkit.slug === input.toolkitSlug,
  );
  const pinnedId = input.pinnedAccountId?.trim() || null;

  // Children created before accounts were pinned have always used "the toolkit's
  // account". Keep that behaviour (first active one, nothing written) instead of
  // degrading them as ambiguous the moment a second account appears.
  if (!pinnedId) {
    const firstActive = toolkitAccounts.find(isActive);
    if (firstActive) return { kind: "pinned_active", account: firstActive };
    return {
      kind: "unavailable",
      pinnedStatus: toolkitAccounts[0]?.status.trim().toUpperCase() || "MISSING",
      reason: "no_active_account",
    };
  }

  const pinned = pinnedId
    ? toolkitAccounts.find((account) => account.id === pinnedId) ?? null
    : null;

  if (pinned && isActive(pinned)) return { kind: "pinned_active", account: pinned };

  const pinnedStatus = pinned ? pinned.status.trim().toUpperCase() || "UNKNOWN" : "MISSING";
  const activeCandidates = toolkitAccounts.filter(
    (account) => account.id !== pinnedId && isActive(account),
  );
  if (activeCandidates.length === 0) {
    return { kind: "unavailable", pinnedStatus, reason: "no_active_account" };
  }

  const eligible = pinned
    ? activeCandidates.filter(
        (account) => account.auth_config?.id === pinned.auth_config?.id,
      )
    : activeCandidates;

  if (eligible.length === 0) {
    return { kind: "unavailable", pinnedStatus, reason: "auth_config_mismatch" };
  }
  if (eligible.length > 1) {
    return { kind: "unavailable", pinnedStatus, reason: "ambiguous" };
  }
  return {
    kind: "rebind",
    account: eligible[0]!,
    previousAccountId: pinnedId,
    previousStatus: pinnedStatus,
  };
}
