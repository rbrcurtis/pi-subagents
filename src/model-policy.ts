/** Runtime policy hook for selecting a subagent model at the spawn boundary. */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModel } from "./model-resolver.js";

export const SUBAGENT_MODEL_POLICY_CHANNEL = "subagents:model-policy";

export interface SubagentModelPolicyRequest {
  agentType: string;
  requestedModel?: string;
  parentProvider: string;
  parentModel: string;
  decision?: SubagentModelPolicyDecision;
}

export type SubagentModelPolicyDecision =
  | { model: string; source: string }
  | { error: string };

function isDecision(value: unknown): value is SubagentModelPolicyDecision {
  if (!value || typeof value !== "object") return false;
  const decision = value as Record<string, unknown>;
  const hasModel = typeof decision.model === "string" && decision.model.length > 0;
  const hasSource = typeof decision.source === "string" && decision.source.length > 0;
  const hasError = typeof decision.error === "string" && decision.error.length > 0;
  return (hasModel && hasSource && !hasError) || (hasError && !hasModel && !hasSource);
}

function assertParentProvider(model: Model<Api>, parent: Model<Api>): void {
  if (model.provider !== parent.provider) {
    throw new Error(
      `Subagent model provider "${model.provider}" does not match parent provider "${parent.provider}"`,
    );
  }
}

export function selectSpawnModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  agentType: string,
  requestedModel?: string,
  fallbackModel?: Model<Api>,
): { model: Model<Api>; source?: string } {
  const parent = ctx.model;
  if (!parent) throw new Error("Cannot select a subagent model without a parent model");

  const request: SubagentModelPolicyRequest = {
    agentType,
    parentProvider: parent.provider,
    parentModel: `${parent.provider}/${parent.id}`,
  };

  let explicit: Model<Api> | undefined;
  if (requestedModel) {
    const resolved = resolveModel(requestedModel, ctx.modelRegistry);
    if (typeof resolved === "string") throw new Error(resolved);
    explicit = resolved as Model<Api>;
    assertParentProvider(explicit, parent);
    request.requestedModel = `${explicit.provider}/${explicit.id}`;
  }

  pi.events.emit(SUBAGENT_MODEL_POLICY_CHANNEL, request);

  if (!request.decision) return { model: explicit ?? fallbackModel ?? parent };
  if (!isDecision(request.decision)) throw new Error("Invalid subagent policy decision");
  if ("error" in request.decision) throw new Error(request.decision.error);

  const slash = request.decision.model.indexOf("/");
  if (slash <= 0) throw new Error(`Invalid subagent policy model: "${request.decision.model}"`);
  const provider = request.decision.model.slice(0, slash);
  const modelId = request.decision.model.slice(slash + 1);
  if (!modelId) throw new Error(`Invalid subagent policy model: "${request.decision.model}"`);
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) throw new Error(`Subagent policy model not found: "${request.decision.model}"`);
  const selected = model as Model<Api>;
  assertParentProvider(selected, parent);
  return { model: selected, source: request.decision.source };
}
