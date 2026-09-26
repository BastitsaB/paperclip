import { describe, expect, it, vi } from "vitest";

import type { ComposioClient, ComposioConnectedAccount } from "../services/composio.js";
import {
  listAllComposioConnectedAccounts,
  selectComposioAccountForChild,
} from "../services/composio-account-selection.js";

function account(
  id: string,
  status: string,
  authConfigId: string | undefined,
  overrides: Partial<ComposioConnectedAccount> = {},
): ComposioConnectedAccount {
  return {
    id,
    user_id: "paperclip:company",
    status,
    toolkit: { slug: "google_analytics" },
    auth_config: {
      id: authConfigId as string,
      auth_scheme: "OAUTH2",
      is_composio_managed: false,
    },
    ...overrides,
  };
}

const base = { toolkitSlug: "google_analytics", listingComplete: true } as const;

describe("selectComposioAccountForChild", () => {
  it("reports a would-be rebind as blocked when the child must keep its account", () => {
    const selection = selectComposioAccountForChild({
      ...base,
      accounts: [account("ca_old", "INITIATED", "ac_custom"), account("ca_new", "ACTIVE", "ac_custom")],
      pinnedAccountId: "ca_old",
      allowRebind: false,
    });
    expect(selection).toEqual({ kind: "unavailable", pinnedStatus: "INITIATED", reason: "rebind_blocked" });
  });

  it("keeps an active pinned account without rebinding", () => {
    const pinned = account("ca_old", "ACTIVE", "ac_custom");
    const selection = selectComposioAccountForChild({
      ...base,
      accounts: [pinned, account("ca_new", "ACTIVE", "ac_custom")],
      pinnedAccountId: "ca_old",
    });
    expect(selection).toEqual({ kind: "pinned_active", account: pinned });
  });

  // The GA case of 2026-09-13: a reconnect in the Composio dashboard created a
  // new account on the same auth config and left the pinned one EXPIRED.
  it("rebinds an expired pin to the new active account of the same auth config", () => {
    const selection = selectComposioAccountForChild({
      ...base,
      accounts: [account("ca_old", "EXPIRED", "ac_custom"), account("ca_new", "ACTIVE", "ac_custom")],
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
      ...base,
      accounts: [account("ca_old", "EXPIRED", "ac_custom"), account("ca_broad", "ACTIVE", "ac_managed")],
      pinnedAccountId: "ca_old",
    });
    expect(selection).toEqual({ kind: "unavailable", pinnedStatus: "EXPIRED", reason: "auth_config_mismatch" });
  });

  it("never treats two missing auth config ids as the same auth config", () => {
    const selection = selectComposioAccountForChild({
      ...base,
      accounts: [account("ca_old", "EXPIRED", undefined), account("ca_new", "ACTIVE", undefined)],
      pinnedAccountId: "ca_old",
    });
    expect(selection).toEqual({ kind: "unavailable", pinnedStatus: "EXPIRED", reason: "auth_config_unknown" });
  });

  // The GSC case: the pinned account was deleted, so its auth config only
  // survives as the value Paperclip recorded on the child.
  it("rebinds a deleted pin only onto the recorded auth config", () => {
    const recorded = selectComposioAccountForChild({
      ...base,
      accounts: [account("ca_broad", "ACTIVE", "ac_managed"), account("ca_new", "ACTIVE", "ac_custom")],
      pinnedAccountId: "ca_deleted",
      recordedAuthConfigId: "ac_custom",
    });
    expect(recorded).toMatchObject({
      kind: "rebind",
      account: { id: "ca_new" },
      previousAccountId: "ca_deleted",
      previousStatus: "MISSING",
    });

    const unknown = selectComposioAccountForChild({
      ...base,
      accounts: [account("ca_new", "ACTIVE", "ac_custom")],
      pinnedAccountId: "ca_deleted",
      recordedAuthConfigId: null,
    });
    expect(unknown).toEqual({ kind: "unavailable", pinnedStatus: "MISSING", reason: "auth_config_unknown" });
  });

  it("does not read a truncated listing as a deleted pin", () => {
    const selection = selectComposioAccountForChild({
      ...base,
      listingComplete: false,
      accounts: [account("ca_new", "ACTIVE", "ac_custom")],
      pinnedAccountId: "ca_on_a_later_page",
      recordedAuthConfigId: "ac_custom",
    });
    expect(selection).toEqual({ kind: "unavailable", pinnedStatus: "MISSING", reason: "incomplete_listing" });
  });

  it("rejects ambiguous replacements on the same auth config", () => {
    const selection = selectComposioAccountForChild({
      ...base,
      accounts: [
        account("ca_old", "EXPIRED", "ac_custom"),
        account("ca_a", "ACTIVE", "ac_custom"),
        account("ca_b", "ACTIVE", "ac_custom"),
      ],
      pinnedAccountId: "ca_old",
    });
    expect(selection).toEqual({ kind: "unavailable", pinnedStatus: "EXPIRED", reason: "ambiguous" });
  });

  it("never replaces an account a human disabled", () => {
    const selection = selectComposioAccountForChild({
      ...base,
      accounts: [
        account("ca_old", "ACTIVE", "ac_custom", { is_disabled: true }),
        account("ca_new", "ACTIVE", "ac_custom"),
      ],
      pinnedAccountId: "ca_old",
    });
    expect(selection).toEqual({ kind: "unavailable", pinnedStatus: "ACTIVE", reason: "pinned_disabled" });
  });

  it("never adopts disabled accounts, disabled auth configs or other toolkits", () => {
    const selection = selectComposioAccountForChild({
      ...base,
      accounts: [
        account("ca_old", "EXPIRED", "ac_custom"),
        account("ca_disabled", "ACTIVE", "ac_custom", { is_disabled: true }),
        account("ca_config_off", "ACTIVE", "ac_custom", {
          auth_config: { id: "ac_custom", auth_scheme: "OAUTH2", is_composio_managed: false, is_disabled: true },
        }),
        account("ca_gmail", "ACTIVE", "ac_custom", { toolkit: { slug: "gmail" } }),
      ],
      pinnedAccountId: "ca_old",
    });
    expect(selection).toEqual({ kind: "unavailable", pinnedStatus: "EXPIRED", reason: "no_active_account" });
  });

  // Children created before pinning existed must not start degrading as
  // "ambiguous" just because a second account shows up.
  it("keeps the legacy first-active behaviour for children without a pin", () => {
    const first = account("ca_a", "ACTIVE", "ac_custom");
    const selection = selectComposioAccountForChild({
      ...base,
      accounts: [account("ca_x", "EXPIRED", "ac_custom"), first, account("ca_b", "ACTIVE", "ac_other")],
      pinnedAccountId: null,
    });
    expect(selection).toEqual({ kind: "pinned_active", account: first });
  });
});

describe("listAllComposioConnectedAccounts", () => {
  function pagedClient(pages: Array<{ items: string[]; next?: string | null }>): ComposioClient {
    let call = 0;
    return {
      listConnectedAccounts: vi.fn(async () => {
        const page = pages[Math.min(call, pages.length - 1)]!;
        call += 1;
        return {
          items: page.items.map((id) => account(id, "ACTIVE", "ac_custom")),
          next_cursor: page.next ?? null,
        };
      }),
    } as unknown as ComposioClient;
  }

  it("follows cursors until the provider reports no further page", async () => {
    const client = pagedClient([{ items: ["a"], next: "c1" }, { items: ["b"], next: null }]);
    const result = await listAllComposioConnectedAccounts(client, { userIds: ["paperclip:company"] });
    expect(result.complete).toBe(true);
    expect(result.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(client.listConnectedAccounts).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "c1" }));
  });

  it("reports a non-advancing cursor as incomplete instead of looping", async () => {
    const client = pagedClient([{ items: ["a"], next: "stuck" }]);
    const result = await listAllComposioConnectedAccounts(client, { userIds: ["paperclip:company"] });
    expect(result.complete).toBe(false);
    expect(client.listConnectedAccounts).toHaveBeenCalledTimes(2);
  });
});
