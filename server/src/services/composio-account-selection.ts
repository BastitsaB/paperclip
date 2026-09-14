import type { ComposioClient, ComposioConnectedAccount } from "./composio.js";

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
 * reconnect on their own, but only when the replacement is unambiguous and
 * cannot widen access. Every "cannot tell" outcome fails closed (the child stays
 * degraded and a human reconnects through Paperclip):
 *
 * - The replacement must use the same auth config as the child used before. A
 *   different auth config can carry different scopes (e.g. Composio's managed
 *   GitHub app with `repo`/`workflow` on every repository instead of a narrowly
 *   installed custom GitHub App), so switching to it would be a privilege change
 *   nobody approved. The previous auth config comes from the still-listed pinned
 *   account, or, when that account was deleted, from the auth config Paperclip
 *   recorded on the child. Unknown auth config means no rebind.
 * - A missing pin only counts as "deleted" when the account listing was complete;
 *   a truncated page must not look like a deleted account.
 * - An account a human disabled is never replaced, and disabled accounts or auth
 *   configs never qualify as replacements.
 * - Children without a pin (created before pinning existed) keep their old
 *   behaviour: first active account, nothing written.
 */
export type ComposioAccountUnavailableReason =
  | "no_active_account"
  | "ambiguous"
  | "auth_config_mismatch"
  | "auth_config_unknown"
  | "incomplete_listing"
  | "pinned_disabled";

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
      reason: ComposioAccountUnavailableReason;
    };

function normalizedStatus(account: ComposioConnectedAccount): string {
  return account.status.trim().toUpperCase();
}

function authConfigIdOf(account: ComposioConnectedAccount): string | null {
  const id = account.auth_config?.id;
  return typeof id === "string" && id.trim() !== "" ? id.trim() : null;
}

function isUsable(account: ComposioConnectedAccount): boolean {
  return (
    normalizedStatus(account) === "ACTIVE" &&
    account.is_disabled !== true &&
    account.auth_config?.is_disabled !== true
  );
}

export function selectComposioAccountForChild(input: {
  accounts: ComposioConnectedAccount[];
  /** False when the provider signalled more pages that were not loaded. */
  listingComplete: boolean;
  toolkitSlug: string;
  pinnedAccountId: string | null | undefined;
  /** Auth config Paperclip recorded on the child when it bound the account. */
  recordedAuthConfigId?: string | null;
}): ComposioAccountSelection {
  const toolkitAccounts = input.accounts.filter(
    (account) => account.toolkit.slug === input.toolkitSlug,
  );
  const pinnedId = input.pinnedAccountId?.trim() || null;

  if (!pinnedId) {
    const firstActive = toolkitAccounts.find(isUsable);
    if (firstActive) return { kind: "pinned_active", account: firstActive };
    return {
      kind: "unavailable",
      pinnedStatus: toolkitAccounts[0] ? normalizedStatus(toolkitAccounts[0]) || "MISSING" : "MISSING",
      reason: "no_active_account",
    };
  }

  const pinned = toolkitAccounts.find((account) => account.id === pinnedId) ?? null;
  if (pinned && isUsable(pinned)) return { kind: "pinned_active", account: pinned };

  const pinnedStatus = pinned ? normalizedStatus(pinned) || "UNKNOWN" : "MISSING";
  if (pinned?.is_disabled === true) {
    return { kind: "unavailable", pinnedStatus, reason: "pinned_disabled" };
  }
  if (!pinned && !input.listingComplete) {
    return { kind: "unavailable", pinnedStatus, reason: "incomplete_listing" };
  }

  const previousAuthConfigId = pinned
    ? authConfigIdOf(pinned)
    : input.recordedAuthConfigId?.trim() || null;
  if (!previousAuthConfigId) {
    return { kind: "unavailable", pinnedStatus, reason: "auth_config_unknown" };
  }

  const activeCandidates = toolkitAccounts.filter(
    (account) => account.id !== pinnedId && isUsable(account),
  );
  if (activeCandidates.length === 0) {
    return { kind: "unavailable", pinnedStatus, reason: "no_active_account" };
  }
  const eligible = activeCandidates.filter(
    (account) => authConfigIdOf(account) === previousAuthConfigId,
  );
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

// Bound on paging so a misbehaving cursor cannot loop forever; hitting it is
// reported as an incomplete listing, which fails closed above.
const MAX_ACCOUNT_PAGES = 20;

/**
 * Loads every page of connected accounts for the filter. The selection above may
 * only treat a pinned account as deleted when this reports `complete: true`.
 */
export async function listAllComposioConnectedAccounts(
  client: ComposioClient,
  filter: { toolkitSlugs?: string[]; userIds: string[] },
): Promise<{ items: ComposioConnectedAccount[]; complete: boolean }> {
  const items: ComposioConnectedAccount[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_ACCOUNT_PAGES; page += 1) {
    const result = await client.listConnectedAccounts({
      ...filter,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    items.push(...result.items);
    const next = result.next_cursor?.trim();
    if (!next) return { items, complete: true };
    // A cursor that does not advance cannot deliver the rest: report it as
    // incomplete instead of pretending the listing ended.
    if (next === cursor) return { items, complete: false };
    cursor = next;
  }
  return { items, complete: false };
}
