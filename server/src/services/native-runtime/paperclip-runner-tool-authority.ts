import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  documentRevisions,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueDocuments,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../../vendor/paperclip-runner/index.js";
import { agentService } from "../agents.js";
import { approvalService } from "../approvals.js";
import { documentService } from "../documents.js";
import { issueService } from "../issues.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { persistActivity, publishActivity } from "../activity-log.js";

const IMPLEMENTED_OPERATIONS = new Set([
  "get_task_context", "get_task_history", "search_tasks", "report_progress",
  "request_human_input",
  "create_task", "set_dependencies",
  "list_documents", "read_document", "list_document_revisions", "write_document",
  "list_agents", "get_agent", "list_approvals", "get_approval", "get_approval_context",
]);

type Binding = {
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
  workMode?: "standard" | "planning" | "ask";
  enqueueWakeup?: (agentId: string, options: {
    source: "assignment";
    triggerDetail: "system";
    reason: "issue_assigned";
    payload: Record<string, unknown>;
    idempotencyKey: string;
    requestedByActorType: "agent";
    requestedByActorId: string;
    contextSnapshot: Record<string, unknown>;
  }) => Promise<unknown>;
};

type ToolReceipt = {
  operationId: string;
  input: unknown;
  result: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export class PaperclipRunnerToolAuthority {
  constructor(readonly db: Db, readonly binding: Binding) {}

  definitions(): Array<Record<string, unknown>> {
    const workMode = this.binding.workMode ?? "standard";
    return CAPABILITY_SEMANTIC_TOOL_CATALOG
      .filter((descriptor) =>
        IMPLEMENTED_OPERATIONS.has(descriptor.operationId)
        && descriptor.allowedModes.includes(workMode)
      )
      .map((descriptor) => ({
        name: descriptor.operationId,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
      }));
  }

  async execute(call: { tool: string; callId: string; arguments: unknown }): Promise<unknown> {
    if (!IMPLEMENTED_OPERATIONS.has(call.tool)) throw new Error("paperclip_runner_tool_not_advertised");
    const context = await this.#boundContext();
    const descriptor = CAPABILITY_SEMANTIC_TOOL_CATALOG.find((candidate) => candidate.operationId === call.tool);
    if (!descriptor || !descriptor.allowedModes.includes(
      context.issue.workMode as "standard" | "planning" | "ask",
    )) {
      throw new Error("paperclip_runner_tool_mode_denied");
    }
    const input = record(call.arguments);
    switch (call.tool) {
      case "get_task_context": return {
        company: { id: this.binding.companyId },
        actor: context.actor,
        activeTask: context.issue,
        run: { id: this.binding.runId },
        acceptedPlan: await this.#acceptedPlan(context.run.contextSnapshot),
      };
      case "get_task_history": {
        const limit = boundedLimit(input.limit);
        const comments = await this.db.select().from(issueComments)
          .where(eq(issueComments.issueId, this.binding.issueId));
        return { comments: comments.slice(-limit) };
      }
      case "search_tasks": {
        const tasks = await issueService(this.db).list(this.binding.companyId);
        const query = typeof input.query === "string" ? input.query.toLowerCase() : "";
        const statuses = Array.isArray(input.statuses) ? new Set(input.statuses.filter((value): value is string => typeof value === "string")) : null;
        return { tasks: tasks.filter((task) =>
          (!query || `${task.identifier} ${task.title} ${task.description ?? ""}`.toLowerCase().includes(query))
          && (!statuses || statuses.size === 0 || statuses.has(task.status))
        ).slice(0, boundedLimit(input.limit)) };
      }
      case "list_documents":
        return { documents: await documentService(this.db).listIssueDocuments(this.binding.issueId) };
      case "read_document": {
        const document = await documentService(this.db).getIssueDocumentByKey(this.binding.issueId, requiredString(input.key));
        if (!document) throw new Error("paperclip_runner_document_not_found");
        return { document };
      }
      case "list_document_revisions":
        return { revisions: await documentService(this.db).listIssueDocumentRevisions(this.binding.issueId, requiredString(input.key)) };
      case "write_document": return this.#writeDocument(input);
      case "list_agents":
        return { actors: (await agentService(this.db).list(this.binding.companyId)).map(redactedActor) };
      case "get_agent": {
        const actor = await agentService(this.db).getById(requiredString(input.actorId));
        if (!actor || actor.companyId !== this.binding.companyId) throw new Error("paperclip_runner_agent_not_found");
        return { actor: redactedActor(actor) };
      }
      case "list_approvals":
        return { approvals: await approvalService(this.db).list(this.binding.companyId) };
      case "get_approval": {
        const approval = await this.#approval(requiredString(input.approvalId));
        return { approval };
      }
      case "get_approval_context": {
        const approval = await this.#approval(requiredString(input.approvalId));
        const tasks = await this.db.select({ issue: issues }).from(issueApprovals)
          .innerJoin(issues, eq(issues.id, issueApprovals.issueId))
          .where(and(
            eq(issueApprovals.approvalId, approval.id),
            eq(issueApprovals.companyId, this.binding.companyId),
            eq(issues.companyId, this.binding.companyId),
          ));
        return { approval, tasks: tasks.map((row) => row.issue) };
      }
      case "report_progress": return this.#reportProgress(call.callId, input, context.issue);
      case "request_human_input": return this.#requestHumanInput(input, context.issue);
      case "create_task": return this.#createTask(input);
      case "set_dependencies": return this.#setDependencies(input);
      default: throw new Error("paperclip_runner_tool_not_bound");
    }
  }

  async #approval(id: string) {
    const approval = await approvalService(this.db).getById(id);
    if (!approval || approval.companyId !== this.binding.companyId) throw new Error("paperclip_runner_approval_not_found");
    return approval;
  }

  async #boundContext() {
    const [row] = await this.db.select({ issue: issues, actor: agents, run: heartbeatRuns })
      .from(heartbeatRuns)
      .innerJoin(issues, eq(issues.id, this.binding.issueId))
      .innerJoin(agents, eq(agents.id, this.binding.agentId))
      .where(and(
        eq(heartbeatRuns.id, this.binding.runId),
        eq(heartbeatRuns.companyId, this.binding.companyId),
        eq(heartbeatRuns.agentId, this.binding.agentId),
        eq(issues.companyId, this.binding.companyId),
        eq(issues.assigneeAgentId, this.binding.agentId),
        eq(issues.executionRunId, this.binding.runId),
        eq(agents.companyId, this.binding.companyId),
      ))
      .limit(1);
    if (!row || row.run.runtimeMode !== "native" || row.run.status !== "running") {
      throw new Error("paperclip_runner_tool_binding_not_authorized");
    }
    return row;
  }

  async #reportProgress(
    callId: string,
    input: Record<string, unknown>,
    issue: typeof issues.$inferSelect,
  ): Promise<unknown> {
    const body = typeof input.body === "string" ? input.body.trim() : "";
    const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
    if (!body || !idempotencyKey) throw new Error("paperclip_runner_tool_input_invalid");
    const mutation = await this.db.transaction(async (tx) => {
      const [run] = await tx.select().from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, this.binding.runId), eq(heartbeatRuns.companyId, this.binding.companyId)))
        .for("update").limit(1);
      if (!run || run.status !== "running" || run.agentId !== this.binding.agentId) {
        throw new Error("paperclip_runner_tool_binding_not_authorized");
      }
      const resultJson = record(run.resultJson);
      const receipts = record(resultJson.semanticToolReceipts);
      const prior = receipts[idempotencyKey] as ToolReceipt | undefined;
      if (prior !== undefined) {
        if (prior.operationId !== "report_progress" || canonicalJson(prior.input) !== canonicalJson(input)) {
          throw new Error("paperclip_runner_tool_idempotency_conflict");
        }
        return { result: prior.result, publication: null };
      }
      const comment = await issueService(this.db).addComment(
        this.binding.issueId,
        body,
        { agentId: this.binding.agentId, runId: this.binding.runId },
        { authorizationReason: "paperclip_runner_protocol" },
        tx,
      );
      const result = { commentId: comment.id, issueId: this.binding.issueId, disposition: "applied" };
      receipts[idempotencyKey] = { operationId: "report_progress", input, result } satisfies ToolReceipt;
      await tx.update(heartbeatRuns).set({
        resultJson: { ...resultJson, semanticToolReceipts: receipts },
        updatedAt: new Date(),
      }).where(eq(heartbeatRuns.id, this.binding.runId));
      const activity = await persistActivity(tx as unknown as Db, {
        companyId: this.binding.companyId,
        actorType: "agent",
        actorId: this.binding.agentId,
        agentId: this.binding.agentId,
        runId: this.binding.runId,
        issueId: this.binding.issueId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: this.binding.issueId,
        details: {
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
          identifier: issue.identifier,
          issueTitle: issue.title,
          authorizationReason: "paperclip_runner_protocol",
          source: "paperclip_runner_protocol",
        },
      });
      return { result, publication: activity.publication };
    });
    if (mutation.publication) publishActivity(mutation.publication);
    return mutation.result;
  }

  async #writeDocument(input: Record<string, unknown>): Promise<unknown> {
    const idempotencyKey = requiredString(input.idempotencyKey);
    let publication: Awaited<ReturnType<typeof persistActivity>>["publication"] | null = null;
    const result = await this.#withMutationReceipt("write_document", idempotencyKey, input, async (tx) => {
      const write = await documentService(tx).upsertIssueDocument({
        issueId: this.binding.issueId,
        key: requiredString(input.key),
        title: requiredString(input.title),
        format: "markdown",
        body: requiredString(input.body),
        baseRevisionId: nullableProviderId(input.baseRevisionId),
        changeSummary: input.changeSummary === null || input.changeSummary === undefined
          ? null
          : requiredString(input.changeSummary),
        createdByAgentId: this.binding.agentId,
        createdByRunId: this.binding.runId,
      });
      const activity = await persistActivity(tx, {
        companyId: this.binding.companyId,
        actorType: "agent",
        actorId: this.binding.agentId,
        agentId: this.binding.agentId,
        runId: this.binding.runId,
        issueId: this.binding.issueId,
        action: write.created ? "issue.document_created" : "issue.document_updated",
        entityType: "issue",
        entityId: this.binding.issueId,
        details: {
          key: write.document.key,
          documentId: write.document.id,
          title: write.document.title,
          format: write.document.format,
          revisionNumber: write.document.latestRevisionNumber,
          source: "paperclip_runner_protocol",
        },
      });
      publication = activity.publication;
      return {
        disposition: "applied",
        created: write.created,
        document: write.document,
      };
    });
    if (publication) publishActivity(publication);
    return result;
  }

  async #createTask(input: Record<string, unknown>): Promise<unknown> {
    const idempotencyKey = requiredString(input.idempotencyKey);
    const assigneeAgentId = input.assigneeActorId === null || input.assigneeActorId === undefined
      ? this.binding.agentId
      : requiredString(input.assigneeActorId);
    const assignee = await agentService(this.db).getById(assigneeAgentId);
    if (!assignee || assignee.companyId !== this.binding.companyId) {
      throw new Error("paperclip_runner_agent_not_found");
    }
    const priority = input.priority === "critical" || input.priority === "high"
      || input.priority === "medium" || input.priority === "low"
      ? input.priority
      : "medium";
    const blockedByIssueIds = Array.isArray(input.blockedByTaskIds)
      ? input.blockedByTaskIds.map(requiredString)
      : [];
    const durableIdempotencyKey =
      `paperclip-runner:create-task:${this.binding.issueId}:${idempotencyKey}`;
    const inputFingerprint = createHash("sha256")
      .update(canonicalJson(input))
      .digest("hex");
    const result = await this.#withMutationReceipt("create_task", idempotencyKey, input, async (tx) => {
      const existingChild = await tx.select().from(issues).where(and(
        eq(issues.companyId, this.binding.companyId),
        eq(issues.parentId, this.binding.issueId),
        eq(issues.originId, durableIdempotencyKey),
      )).limit(1).then((rows) => rows[0] ?? null);
      if (existingChild) {
        if (existingChild.originFingerprint !== inputFingerprint) {
          throw new Error("paperclip_runner_tool_idempotency_conflict");
        }
        return {
          commandId: `create-task:${existingChild.id}`,
          disposition: "duplicate",
          stateRevision: existingChild.statusVersion,
          entityRefs: [existingChild.id],
          scheduledWakeIds: [],
          task: {
            id: existingChild.id,
            identifier: existingChild.identifier,
            parentId: existingChild.parentId,
            status: existingChild.status,
            assigneeActorId: existingChild.assigneeAgentId,
          },
        };
      }
      let deduplicated = false;
      const created = await issueService(tx).createChild(this.binding.issueId, {
        title: requiredString(input.title),
        description: input.description === null || input.description === undefined
          ? null
          : requiredString(input.description),
        status: blockedByIssueIds.length > 0 ? "blocked" : "todo",
        workMode: "standard",
        priority,
        assigneeAgentId,
        blockedByIssueIds,
        blockParentUntilDone: false,
        createdByAgentId: this.binding.agentId,
        originKind: "manual",
        originId: durableIdempotencyKey,
        originFingerprint: inputFingerprint,
        actorAgentId: this.binding.agentId,
        actorRunId: this.binding.runId,
        idempotencyKey: durableIdempotencyKey,
        onDeduplicated: () => { deduplicated = true; },
      });
      const child = created.issue;
      if (deduplicated && child.originFingerprint !== inputFingerprint) {
        throw new Error("paperclip_runner_tool_idempotency_conflict");
      }
      let childStatus = child.status;
      let childStatusVersion = child.statusVersion;
      if (child.status === "blocked" && blockedByIssueIds.length > 0) {
        const readiness = await issueService(tx).getDependencyReadiness(child.id, tx);
        if (readiness.isDependencyReady) {
          const readyChild = await issueService(tx).update(child.id, {
            status: "todo",
            actorAgentId: this.binding.agentId,
          }, tx);
          if (readyChild) {
            childStatus = readyChild.status;
            childStatusVersion = readyChild.statusVersion;
          }
        }
      }
      const wakeId = `created-child:${child.id}`;
      const shouldWake = !deduplicated && childStatus === "todo" && Boolean(child.assigneeAgentId);
      return {
        commandId: `create-task:${child.id}`,
        disposition: deduplicated ? "duplicate" : "applied",
        stateRevision: childStatusVersion,
        entityRefs: [child.id],
        scheduledWakeIds: shouldWake ? [wakeId] : [],
        task: {
          id: child.id,
          identifier: child.identifier,
          parentId: child.parentId,
          status: childStatus,
          assigneeActorId: child.assigneeAgentId,
        },
      };
    }) as Record<string, unknown>;

    const task = record(result.task);
    const childId = requiredString(task.id);
    const scheduledWakeIds = Array.isArray(result.scheduledWakeIds)
      ? result.scheduledWakeIds.filter((value): value is string => typeof value === "string")
      : [];
    const assignedAgentId = typeof task.assigneeActorId === "string"
      ? task.assigneeActorId
      : null;
    if (this.binding.enqueueWakeup && assignedAgentId && scheduledWakeIds.length > 0) {
      await this.binding.enqueueWakeup(assignedAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: {
          issueId: childId,
          mutation: "create_child",
          parentIssueId: this.binding.issueId,
        },
        idempotencyKey: scheduledWakeIds[0]!,
        requestedByActorType: "agent",
        requestedByActorId: this.binding.agentId,
        contextSnapshot: {
          issueId: childId,
          source: "paperclip_runner.create_task",
          parentIssueId: this.binding.issueId,
        },
      });
    }
    return result;
  }

  async #setDependencies(input: Record<string, unknown>): Promise<unknown> {
    const idempotencyKey = requiredString(input.idempotencyKey);
    if (!Array.isArray(input.blockedByTaskIds)) {
      throw new Error("paperclip_runner_tool_input_invalid");
    }
    const blockedByIssueIds = input.blockedByTaskIds.map(requiredString);
    return this.#withMutationReceipt("set_dependencies", idempotencyKey, input, async (tx) => {
      const updated = await issueService(tx).update(this.binding.issueId, {
        blockedByIssueIds,
        actorAgentId: this.binding.agentId,
      }, tx);
      if (!updated) throw new Error("paperclip_runner_task_not_found");
      return {
        commandId: `set-dependencies:${updated.id}:${updated.statusVersion}`,
        disposition: "applied",
        stateRevision: updated.statusVersion,
        entityRefs: [updated.id, ...blockedByIssueIds],
        scheduledWakeIds: [],
      };
    });
  }

  async #acceptedPlan(contextSnapshot: unknown): Promise<{
    documentId: string;
    revisionId: string;
    revisionNumber: number;
    markdown: string;
  } | null> {
    const acceptedTarget = record(
      record(record(contextSnapshot).planReviewInteraction).acceptedTargetRevision,
    );
    let revisionId = typeof acceptedTarget.revisionId === "string"
      ? acceptedTarget.revisionId
      : null;
    if (!revisionId) revisionId = await this.#latestAcceptedPlanRevisionId();
    if (!revisionId) return null;

    const [revision] = await this.db.select({
      documentId: documentRevisions.documentId,
      revisionId: documentRevisions.id,
      revisionNumber: documentRevisions.revisionNumber,
      markdown: documentRevisions.body,
    })
      .from(documentRevisions)
      .innerJoin(issueDocuments, and(
        eq(issueDocuments.documentId, documentRevisions.documentId),
        eq(issueDocuments.companyId, this.binding.companyId),
        eq(issueDocuments.issueId, this.binding.issueId),
        eq(issueDocuments.key, "plan"),
      ))
      .where(and(
        eq(documentRevisions.id, revisionId),
        eq(documentRevisions.companyId, this.binding.companyId),
      ))
      .limit(1);
    return revision ?? null;
  }

  async #latestAcceptedPlanRevisionId(): Promise<string | null> {
    const rows = await this.db.select({ payload: issueThreadInteractions.payload })
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, this.binding.companyId),
        eq(issueThreadInteractions.issueId, this.binding.issueId),
        eq(issueThreadInteractions.kind, "request_confirmation"),
        eq(issueThreadInteractions.status, "accepted"),
      ))
      .orderBy(desc(issueThreadInteractions.resolvedAt), desc(issueThreadInteractions.createdAt));
    for (const row of rows) {
      const target = record(record(row.payload).target);
      if (
        target.type === "issue_document"
        && (target.issueId === undefined || target.issueId === this.binding.issueId)
        && target.key === "plan"
        && typeof target.revisionId === "string"
        && target.revisionId.length > 0
      ) return target.revisionId;
    }
    return null;
  }

  async #withMutationReceipt(
    operationId: string,
    idempotencyKey: string,
    input: Record<string, unknown>,
    effect: (tx: Db) => Promise<unknown>,
  ): Promise<unknown> {
    return this.db.transaction(async (tx) => {
      const [run] = await tx.select().from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, this.binding.runId), eq(heartbeatRuns.companyId, this.binding.companyId)))
        .for("update").limit(1);
      if (!run || run.status !== "running" || run.agentId !== this.binding.agentId) {
        throw new Error("paperclip_runner_tool_binding_not_authorized");
      }
      const resultJson = record(run.resultJson);
      const receipts = record(resultJson.semanticToolReceipts);
      const prior = receipts[idempotencyKey] as ToolReceipt | undefined;
      if (prior !== undefined) {
        if (prior.operationId !== operationId || canonicalJson(prior.input) !== canonicalJson(input)) {
          throw new Error("paperclip_runner_tool_idempotency_conflict");
        }
        return prior.result;
      }
      const result = JSON.parse(JSON.stringify(await effect(tx as unknown as Db))) as unknown;
      receipts[idempotencyKey] = { operationId, input, result } satisfies ToolReceipt;
      await tx.update(heartbeatRuns).set({
        resultJson: { ...resultJson, semanticToolReceipts: receipts },
        updatedAt: new Date(),
      }).where(eq(heartbeatRuns.id, this.binding.runId));
      return result;
    });
  }

  async #requestHumanInput(input: Record<string, unknown>, issue: typeof issues.$inferSelect): Promise<unknown> {
    const interactionKind = requiredString(input.interactionKind);
    const kind = ({
      confirmation: "request_confirmation",
      checkbox: "request_checkbox_confirmation",
      questions: "ask_user_questions",
      suggest_tasks: "suggest_tasks",
      item_verdicts: "request_item_verdicts",
    } as const)[interactionKind as "confirmation"];
    if (!kind) throw new Error("paperclip_runner_interaction_kind_invalid");
    const suppliedPayload = record(input.payload);
    const targetRevisionId = nullableProviderId(input.targetRevisionId);
    const suppliedTarget = record(suppliedPayload.target);
    const inferredPlanningTarget = targetRevisionId !== null
      && suppliedPayload.target === undefined
      && kind === "request_confirmation"
      && this.binding.workMode === "planning"
      ? {
          type: "issue_document",
          issueId: issue.id,
          key: "plan",
          revisionId: targetRevisionId,
        }
      : null;
    if (targetRevisionId !== null && suppliedPayload.target === undefined && inferredPlanningTarget === null) {
      throw new Error("paperclip_runner_interaction_target_incomplete");
    }
    const normalizedPayload = inferredPlanningTarget !== null
      ? { ...suppliedPayload, target: inferredPlanningTarget }
      : suppliedTarget.type === "issue_document"
      ? {
          ...suppliedPayload,
          target: {
            ...suppliedTarget,
            issueId: suppliedTarget.issueId ?? issue.id,
            revisionId: suppliedTarget.revisionId ?? targetRevisionId,
          },
        }
      : suppliedPayload;
    const prompt = requiredString(input.prompt);
    const interaction = await issueThreadInteractionService(this.db).create(issue, {
      kind,
      idempotencyKey: requiredString(input.idempotencyKey),
      sourceRunId: this.binding.runId,
      title: requiredString(input.title),
      summary: prompt,
      continuationPolicy: requiredString(input.continuationPolicy),
      payload: {
        ...normalizedPayload,
        version: 1,
        prompt,
        ...(kind === "request_confirmation" ? {
          detailsMarkdown: normalizedPayload.detailsMarkdown ?? "",
          acceptLabel: normalizedPayload.acceptLabel ?? "Confirm",
          rejectLabel: normalizedPayload.rejectLabel ?? "Request changes",
          rejectRequiresReason: normalizedPayload.rejectRequiresReason ?? false,
          supersedeOnUserComment: normalizedPayload.supersedeOnUserComment ?? true,
        } : {}),
      },
    } as never, { agentId: this.binding.agentId, userId: null });
    const activity = await persistActivity(this.db, {
      companyId: this.binding.companyId,
      actorType: "agent",
      actorId: this.binding.agentId,
      agentId: this.binding.agentId,
      runId: this.binding.runId,
      issueId: this.binding.issueId,
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: this.binding.issueId,
      details: {
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        interactionStatus: interaction.status,
        continuationPolicy: interaction.continuationPolicy,
        source: "paperclip_runner_protocol",
      },
    });
    publishActivity(activity.publication);
    return { interaction, disposition: "applied" };
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("paperclip_runner_tool_input_invalid");
  return value.trim();
}

/**
 * Some native tool transports cannot faithfully express a nullable string in
 * their provider-facing schema and send the JSON null sentinel as a string.
 * Normalize only the well-known empty/null sentinels at the control-plane
 * boundary; real revision ids remain untouched and optimistic concurrency is
 * still enforced by the document service.
 */
function nullableProviderId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = requiredString(value);
  return normalized === "null" || normalized === "undefined" ? null : normalized;
}

function boundedLimit(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(1, Math.min(value, 100))
    : 50;
}

function redactedActor(actor: {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title?: string | null;
  status: string;
  reportsTo?: string | null;
}) {
  return {
    id: actor.id,
    companyId: actor.companyId,
    name: actor.name,
    role: actor.role,
    title: actor.title ?? null,
    status: actor.status,
    reportsTo: actor.reportsTo ?? null,
  };
}
