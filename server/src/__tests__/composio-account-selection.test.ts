import { describe, expect, it } from "vitest";

import type { ComposioConnectedAccount } from "../services/composio.js";
import { selectComposioAccountForChild } from "../services/composio-account-selection.js";

function account(
  id: string,
  status: string,
  authConfigId: string,
  overrides: Partial<ComposioConnectedAccount> = {},
): ComposioConnectedAccount {
  return {
    id,
    user_id: "paperclip:company",
    status,
    toolkit: { slug: "google_analytics" },
    auth_config: { id: authConfigId, auth_scheme: "OAUTH2", is_composio_managed: false },
    ...overrides,
  };
}

describe("selectComposioAccountForChild", () => {
  it("keeps an active pinned account without rebinding", () => {
    const pinned = account("ca_old", "ACTIVE", "ac_custom");
    const selection = selectComposioAccountForChild({
      accounts: [pinned, account("ca_new", "ACTIVE", "ac_custom")],
      toolkitSlug: "google_analytics",
      pinnedAccountId: "ca_old",
    });
    expect(selection).toEqual({ kind: "pinned_active", account: pinned });
  });

  // The GA case of 2026-09-13: a reconnect in the Composio dashboard created a
  // new account on the same auth config and left the pinned one EXPIRED.
  it("rebinds an expired pin to the new active account of the same auth config", () => {
    const selection = selectComposioAccountForChild({
      accounts: [
        account("ca_old", "EXPIRED", "ac_custom"),
        account("ca_new", "ACTIVE", "ac_custom"),
      ],
      toolkitSlug: "google_analytics",
      pinnedAccountId: "ca_old",
    });
    expect(selection).toMatchObject({
      kind: "rebind",
      account: { id: "ca_new" },
      previousAccountId: "ca_old",
      previousStatus: "EXPIRED",
    });
  });

  // A different auth config can carry different scopes (Composio's managed
  // GitHub app versus a narrowly installed custom app): never switch silently.
  it("refuses to rebind across auth configs", () => {
    const selection = selectComposioAccountForChild({
      accounts: [
        account("ca_old", "EXPIRED", "ac_custom"),
        account("ca_broad", "ACTIVE", "ac_managed"),
      ],
      toolkitSlug: "google_analytics",
      pinnedAccountId: "ca_old",
    });
    expect(selection).toEqual({
      kind: "unavailable",
      pinnedStatus: "EXPIRED",
      reason: "auth_config_mismatch",
    });
  });

  // The GSC case: the pinned account was deleted, so its auth config is unknown.
  it("rebinds a missing pin only when exactly one active account exists", () => {
    const single = selectComposioAccountForChild({
      accounts: [account("ca_new", "ACTIVE", "ac_custom")],
      toolkitSlug: "google_analytics",
      pinnedAccountId: "ca_deleted",
    });
    expect(single).toMatchObject({
      kind: "rebind",
      account: { id: "ca_new" },
      previousAccountId: "ca_deleted",
      previousStatus: "MISSING",
    });

    const several = selectComposioAccountForChild({
      accounts: [
        account("ca_a", "ACTIVE", "ac_custom"),
        account("ca_b", "ACTIVE", "ac_other"),
      ],
      toolkitSlug: "google_analytics",
      pinnedAccountId: "ca_deleted",
    });
    expect(several).toEqual({
      kind: "unavailable",
      pinnedStatus: "MISSING",
      reason: "ambiguous",
    });
  });

  it("never adopts disabled accounts or accounts of another toolkit", () => {
    const selection = selectComposioAccountForChild({
      accounts: [
        account("ca_old", "EXPIRED", "ac_custom"),
        account("ca_disabled", "ACTIVE", "ac_custom", { is_disabled: true }),
        account("ca_gmail", "ACTIVE", "ac_custom", { toolkit: { slug: "gmail" } }),
      ],
      toolkitSlug: "google_analytics",
      pinnedAccountId: "ca_old",
    });
    expect(selection).toEqual({
      kind: "unavailable",
      pinnedStatus: "EXPIRED",
      reason: "no_active_account",
    });
  });

  // Children created before pinning existed must not start degrading as
  // "ambiguous" just because a second account shows up.
  it("keeps the legacy first-active behaviour for children without a pin", () => {
    const first = account("ca_a", "ACTIVE", "ac_custom");
    const selection = selectComposioAccountForChild({
      accounts: [account("ca_x", "EXPIRED", "ac_custom"), first, account("ca_b", "ACTIVE", "ac_other")],
      toolkitSlug: "google_analytics",
      pinnedAccountId: null,
    });
    expect(selection).toEqual({ kind: "pinned_active", account: first });
  });
});
