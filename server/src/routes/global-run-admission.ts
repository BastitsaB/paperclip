import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  globalRunAdmissionEmergencyStopSchema,
  globalRunAdmissionResumeSchema,
  patchGlobalRunAdmissionCapSchema,
  patchGlobalRunAdmissionAuthorizedAgentsSchema,
} from "@paperclipai/shared";
import { forbidden, badRequest } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { globalRunAdmissionService } from "../services/global-run-admission.js";
import { instanceSettingsService, logActivity } from "../services/index.js";
import { assertBoardOrAgent, assertInstanceAdmin, getActorInfo } from "./authz.js";

/**
 * Global run-admission governance (MAI-890/MAI-1035): cap + emergency-stop
 * ("Not-Aus") state for the instance-wide run cap enforced in
 * services/heartbeat.ts (`claimQueuedRun` / `getSchedulingSuppression`).
 *
 * Authorization model, per the approved MAI-890 decision — there is no
 * "Chief of Staff"/"CTO"/"Board" role in this codebase (those are free-text
 * agent titles, not permissions; see services/company-member-roles.ts and
 * services/authorization.ts for the actual role model). This is deliberately
 * NOT a free-text-title check (a renamed agent could otherwise self-grant),
 * so authorization is server-checked against two closed sets instead:
 *   - a human board session with instance-admin access (the existing
 *     `assertInstanceAdmin` gate used for /instance/settings), covering
 *     "Board/Auftraggeber"; and
 *   - an explicit, board-managed allowlist of agent ids
 *     (`globalRunAdmission.authorizedAgentIds`), covering the "Chief of
 *     Staff"/"CTO" incident-delegate agent personas named in the approval.
 * Only a human instance-admin may edit that allowlist (see
 * `PATCH /run-admission/authorized-agents` below) — an agent can never add
 * itself or another agent to it, which forecloses privilege self-escalation.
 */

function assertRunAdmissionGovernanceAccess(req: Request, authorizedAgentIds: string[]) {
  if (req.actor.type === "board") {
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    throw forbidden("Instance admin access required");
  }
  if (req.actor.type === "agent") {
    const agentId = req.actor.agentId ?? null;
    if (agentId && authorizedAgentIds.includes(agentId)) return;
    throw forbidden("Agent is not on the global run-admission authorized list", {
      code: "run_admission_agent_not_authorized",
    });
  }
  throw forbidden("Board or authorized agent access required");
}

// Request shapes live in @paperclipai/shared so routes/openapi.ts documents the
// same schema the handler validates against, rather than a hand-copied twin.
const emergencyStopSchema = globalRunAdmissionEmergencyStopSchema;
const resumeSchema = globalRunAdmissionResumeSchema;
const capSchema = patchGlobalRunAdmissionCapSchema;
const authorizedAgentsSchema = patchGlobalRunAdmissionAuthorizedAgentsSchema;

export function globalRunAdmissionRoutes(db: Db) {
  const router = Router();
  const svc = globalRunAdmissionService(db);
  const instanceSettings = instanceSettingsService(db);

  async function auditAcrossCompanies(
    req: Request,
    action: string,
    details: Record<string, unknown>,
  ) {
    const actor = getActorInfo(req);
    const companyIds = await instanceSettings.listCompanyIds();
    await Promise.all(
      companyIds.map((companyId) =>
        logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action,
          entityType: "global_run_admission",
          entityId: "default",
          details,
        }),
      ),
    );
  }

  function toPublicState(state: Awaited<ReturnType<typeof svc.getState>>) {
    return {
      maxConcurrentRuns: state.maxConcurrentRuns,
      emergencyStopActive: state.emergencyStopActive,
      emergencyStopReason: state.emergencyStopReason,
      emergencyStopActor: state.emergencyStopActor,
      emergencyStopActivatedAt: state.emergencyStopActivatedAt,
      authorizedAgentIds: state.authorizedAgentIds,
      updatedAt: state.updatedAt,
    };
  }

  router.get("/run-admission/status", async (req, res) => {
    assertBoardOrAgent(req);
    const [state, runningCount] = await Promise.all([
      svc.getState({ bypassCache: true }),
      svc.countGloballyRunning(),
    ]);
    res.json({ ...toPublicState(state), currentlyRunning: runningCount });
  });

  router.patch(
    "/run-admission/cap",
    validate(capSchema),
    async (req, res) => {
      const current = await svc.getState({ bypassCache: true });
      assertRunAdmissionGovernanceAccess(req, current.authorizedAgentIds);
      const previousCap = current.maxConcurrentRuns;
      const updated = await svc.setCap(req.body.maxConcurrentRuns);
      await auditAcrossCompanies(req, "global_run_admission.cap_changed", {
        previousCap,
        newCap: updated.maxConcurrentRuns,
        reason: req.body.reason,
      });
      res.json(toPublicState(updated));
    },
  );

  router.post(
    "/run-admission/emergency-stop",
    validate(emergencyStopSchema),
    async (req, res) => {
      const current = await svc.getState({ bypassCache: true });
      assertRunAdmissionGovernanceAccess(req, current.authorizedAgentIds);
      const actor = getActorInfo(req);
      if (current.emergencyStopActive) {
        throw badRequest("Global emergency stop is already active", {
          code: "run_admission_already_stopped",
          activatedAt: current.emergencyStopActivatedAt,
        });
      }
      const updated = await svc.activateEmergencyStop({
        reason: req.body.reason,
        actor: { type: actor.actorType, id: actor.actorId },
      });
      await auditAcrossCompanies(req, "global_run_admission.emergency_stop_activated", {
        reason: req.body.reason,
      });
      res.json(toPublicState(updated));
    },
  );

  router.post(
    "/run-admission/resume",
    validate(resumeSchema),
    async (req, res) => {
      const current = await svc.getState({ bypassCache: true });
      assertRunAdmissionGovernanceAccess(req, current.authorizedAgentIds);
      if (!current.emergencyStopActive) {
        throw badRequest("Global emergency stop is not active", {
          code: "run_admission_not_stopped",
        });
      }
      const updated = await svc.clearEmergencyStop();
      await auditAcrossCompanies(req, "global_run_admission.emergency_stop_resumed", {
        previousReason: current.emergencyStopReason,
        resumeReason: req.body.reason ?? null,
        effectiveCapOnResume: updated.maxConcurrentRuns,
      });
      res.json(toPublicState(updated));
    },
  );

  // Only a human instance admin may change who else is authorized — an agent
  // can never add itself (or another agent) here, which is what forecloses
  // privilege self-escalation for the two governance routes above.
  router.patch(
    "/run-admission/authorized-agents",
    validate(authorizedAgentsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const previous = await svc.getState({ bypassCache: true });
      const updated = await svc.setAuthorizedAgentIds(req.body.agentIds);
      await auditAcrossCompanies(req, "global_run_admission.authorized_agents_changed", {
        previousAgentIds: previous.authorizedAgentIds,
        newAgentIds: updated.authorizedAgentIds,
        reason: req.body.reason,
      });
      res.json(toPublicState(updated));
    },
  );

  return router;
}

