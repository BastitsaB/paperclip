import { Router } from "express";
import type { Db } from "@paperclipai/db";

import { remoteAgentProfileService, type RemoteAgentProfileInput, type RemoteAgentService } from "../services/remote-agent-profiles.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity } from "../services/activity-log.js";
import { unprocessable } from "../errors.js";

function profileInput(value: unknown): RemoteAgentProfileInput {
  if (!value || typeof value !== "object") throw unprocessable("Remote Agent profile body is required");
  const body = value as Record<string, unknown>;
  const service = body.service;
  if (service !== "anthropic_managed_agents" && service !== "aws_bedrock_agentcore_harness") throw unprocessable("Unsupported remote agent service");
  return {
    profileKey: String(body.profileKey ?? ""), displayName: String(body.displayName ?? ""),
    service: service as RemoteAgentService,
    configuration: body.configuration && typeof body.configuration === "object" && !Array.isArray(body.configuration) ? body.configuration as Record<string, unknown> : {},
    credentialSecretId: typeof body.credentialSecretId === "string" ? body.credentialSecretId : null,
    enabled: body.enabled === true, retentionAcknowledged: body.retentionAcknowledged === true,
    qualification: body.qualification && typeof body.qualification === "object" && !Array.isArray(body.qualification) ? body.qualification as Record<string, unknown> : {},
  };
}

export function remoteAgentProfileRoutes(db: Db) {
  const router = Router();
  const profiles = remoteAgentProfileService(db);
  router.get("/companies/:companyId/remote-agent-profiles", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const service = typeof req.query.service === "string" ? req.query.service as RemoteAgentService : undefined;
    res.json(await profiles.list(companyId, service));
  });
  router.post("/companies/:companyId/remote-agent-profiles", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const profile = await profiles.upsert(companyId, profileInput(req.body));
    const actor = getActorInfo(req);
    await logActivity(db, { companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId,
      action: "remote_agent_profile.qualified", entityType: "remote_agent_profile", entityId: profile.id,
      details: { profileKey: profile.profileKey, service: profile.service, enabled: profile.enabled, retentionAcknowledged: profile.retentionAcknowledged } });
    res.status(201).json(profile);
  });
  return router;
}
