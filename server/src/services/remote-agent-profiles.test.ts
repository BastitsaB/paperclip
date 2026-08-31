import type { Db } from "@paperclipai/db";
import { describe, expect, it } from "vitest";

import { managedAgentProfileService } from "./managed-agent-profiles.js";
import {
  remoteAgentProfileService,
  type RemoteAgentProfileInput,
} from "./remote-agent-profiles.js";

const COMPANY_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_COMPANY_SECRET_ID = "20000000-0000-4000-8000-000000000002";

const AWS_CONFIGURATION = {
  region: "us-east-1",
  accountId: "123456789012",
  harnessArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/example",
  harnessVersion: "1",
  endpointArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:endpoint/example",
  endpointQualifier: "paperclip",
  agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/example",
  memoryArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/example",
  memoryId: "memory-example",
  invocationRoleArn: "arn:aws:iam::123456789012:role/paperclip-runner",
  contextBucket: "paperclip-runner-context",
  contextPrefix: "profiles/example",
  contextKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/example",
  qualificationRevision: "agentcore-harness-v1",
  defaultModel: "claude-sonnet-4-6",
  eventExpiryDays: 90,
} as const;

function remoteInput(
  overrides: Partial<RemoteAgentProfileInput> = {},
): RemoteAgentProfileInput {
  return {
    profileKey: "agentcore",
    displayName: "AgentCore",
    service: "aws_bedrock_agentcore_harness",
    configuration: { ...AWS_CONFIGURATION },
    enabled: false,
    retentionAcknowledged: false,
    ...overrides,
  };
}

function dbWithoutMatchingSecrets(): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
  } as unknown as Db;
}

const unusedDb = new Proxy({}, {
  get() {
    throw new Error("validation unexpectedly accessed the database");
  },
}) as unknown as Db;

describe("remote agent profile metadata validation", () => {
  it("rejects provider configuration keys outside the exact allowlist", async () => {
    await expect(
      remoteAgentProfileService(unusedDb).upsert(
        COMPANY_ID,
        remoteInput({
          configuration: {
            ...AWS_CONFIGURATION,
            customEndpointToken: "not-persistable",
          },
        }),
      ),
    ).rejects.toThrow("Unsupported configuration field");
  });

  it("rejects secret-shaped values and qualification fields", async () => {
    await expect(
      remoteAgentProfileService(unusedDb).upsert(
        COMPANY_ID,
        remoteInput({
          configuration: {
            ...AWS_CONFIGURATION,
            qualificationRevision: "Bearer secret-value",
          },
        }),
      ),
    ).rejects.toThrow("must not contain credential-shaped keys or values");

    await expect(
      remoteAgentProfileService(unusedDb).upsert(
        COMPANY_ID,
        remoteInput({
          qualification: { apiToken: "secret-value" },
        }),
      ),
    ).rejects.toThrow("must not contain credential-shaped keys or values");
  });

  it("rejects credential references that do not resolve in the owning company", async () => {
    await expect(
      remoteAgentProfileService(dbWithoutMatchingSecrets()).upsert(
        COMPANY_ID,
        remoteInput({ credentialSecretId: OTHER_COMPANY_SECRET_ID }),
      ),
    ).rejects.toThrow("credential secret reference is invalid");

    await expect(
      managedAgentProfileService(dbWithoutMatchingSecrets()).upsert(
        COMPANY_ID,
        {
          profileKey: "managed",
          displayName: "Managed Agent",
          anthropicAgentId: "agent-example",
          agentVersion: "1",
          environmentId: "environment-example",
          defaultModel: "claude-sonnet-5",
          defaultMaxListCostUsd: 1,
          apiKeySecretId: OTHER_COMPANY_SECRET_ID,
          enabled: false,
          retentionAcknowledged: false,
          qualification: {},
        },
      ),
    ).rejects.toThrow("API-key secret reference is invalid");
  });
});
