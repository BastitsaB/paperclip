import type { AdapterAuthSignal } from "@paperclipai/shared";

/**
 * The environment and auth state the connect step reads, as something a story
 * can choose.
 *
 * The step's provider sign-in panel is gated on four separate things — the
 * adapter declaring a login capability, a *sandbox* environment resolving, that
 * environment's provider supporting a login PTY, and the auth signal coming back
 * absent. Miss any one and the panel silently does not render, which looks
 * exactly like it having been deleted.
 *
 * That is not hypothetical: the first version of these fixtures returned an
 * empty environment list, and the sign-in panel was invisible in every story
 * because of it. So the states are named here and selected per story rather than
 * left implicit in a single hard-coded response.
 */

export type OnboardingEnvironmentState =
  /** A cloud tenant as it should be: one managed sandbox, sign-in reachable. */
  | "managed-sandbox"
  /** The broken shape seen on staging — the step can offer no place to test. */
  | "none";

export const STORYBOOK_SANDBOX_PROVIDER = "daytona";
export const STORYBOOK_SANDBOX_ENVIRONMENT_ID = "environment-storybook-sandbox";

interface FixtureState {
  environments: OnboardingEnvironmentState;
  authSignal: AdapterAuthSignal;
}

/**
 * Mutable on purpose. The fetch fixtures are installed once, before any story
 * renders, so a story cannot swap the handler — it sets what the handler reads.
 */
export const onboardingFixtureState: FixtureState = {
  environments: "managed-sandbox",
  authSignal: "absent",
};

export function setOnboardingFixtureState(next: Partial<FixtureState>): void {
  Object.assign(onboardingFixtureState, next);
}

export function resetOnboardingFixtureState(): void {
  onboardingFixtureState.environments = "managed-sandbox";
  onboardingFixtureState.authSignal = "absent";
}

/**
 * `managedByPaperclip` and a non-local driver are what `resolveManagedSandbox
 * EnvironmentId` looks for; `config.provider` is what the capability lookup keys
 * on. All three have to line up or the environment resolves and the panel still
 * does not appear.
 */
export function storybookEnvironments(): unknown[] {
  if (onboardingFixtureState.environments === "none") return [];
  return [
    {
      id: STORYBOOK_SANDBOX_ENVIRONMENT_ID,
      companyId: "company-storybook",
      name: "Managed sandbox",
      driver: "sandbox",
      status: "active",
      config: { provider: STORYBOOK_SANDBOX_PROVIDER },
      metadata: { managedByPaperclip: true },
    },
  ];
}

export function storybookEnvironmentCapabilities(): unknown {
  return {
    sandboxProviders: {
      [STORYBOOK_SANDBOX_PROVIDER]: { supportsLoginPty: true },
    },
  };
}

export function storybookAuthSignal(): { status: AdapterAuthSignal } {
  return { status: onboardingFixtureState.authSignal };
}
