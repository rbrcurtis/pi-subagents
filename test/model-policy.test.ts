import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  SUBAGENT_MODEL_POLICY_CHANNEL,
  type SubagentModelPolicyRequest,
  selectSpawnModel,
} from "../src/model-policy.js";

type PolicyEvents = {
  emit(channel: string, request: SubagentModelPolicyRequest): void;
};

type TestModel = Model<unknown> & { id: string; provider: string; name: string };

function fixture(provider: string, ids: string[]) {
  const all = ids.map((id) => ({ id, provider, name: id } as TestModel));
  const models = {
    auto: all.find((model) => model.id === "auto")!,
    sonnet: all.find((model) => model.id.includes("sonnet"))!,
    opus: all.find((model) => model.id.includes("opus"))!,
  };
  const events: PolicyEvents = { emit() {} };
  const pi = { events } as unknown as ExtensionAPI;
  const ctx = {
    model: models.auto,
    modelRegistry: {
      find: (modelProvider: string, id: string) => all.find((model) => model.provider === modelProvider && model.id === id),
      getAll: () => all,
      getAvailable: () => all,
    },
  } as unknown as ExtensionContext;
  return { pi, ctx, models };
}

function installPolicy(events: PolicyEvents, policy: (request: SubagentModelPolicyRequest) => void) {
  events.emit = (channel, request) => {
    if (channel === SUBAGENT_MODEL_POLICY_CHANNEL) policy(request);
  };
}

describe("selectSpawnModel", () => {
  it("uses an explicit same-provider model before the policy mapping", () => {
    const { pi, ctx, models } = fixture("trackable", ["auto", "claude-sonnet-4-6"]);
    installPolicy(pi.events as unknown as PolicyEvents, (req) => {
      expect(req.requestedModel).toBe("trackable/claude-sonnet-4-6");
      req.decision = { model: req.requestedModel!, source: "explicit" };
    });

    expect(selectSpawnModel(pi, ctx, "Explore", "sonnet").model).toBe(models.sonnet);
  });

  it("uses the policy-selected exact model when no explicit model is supplied", () => {
    const { pi, ctx, models } = fixture("trackable", ["auto", "claude-opus-4-6"]);
    installPolicy(pi.events as unknown as PolicyEvents, (req) => {
      req.decision = { model: "trackable/claude-opus-4-6", source: "lightweight tier" };
    });

    expect(selectSpawnModel(pi, ctx, "Explore").model).toBe(models.opus);
  });

  it("throws a policy rejection before spawn", () => {
    const { pi, ctx } = fixture("trackable", ["auto"]);
    installPolicy(pi.events as unknown as PolicyEvents, (req) => {
      req.decision = { error: 'Subagent model "anthropic/claude-haiku-4-5" is not allowed. This session uses provider "trackable".' };
    });

    expect(() => selectSpawnModel(pi, ctx, "Explore", "anthropic/claude-haiku-4-5"))
      .toThrow('This session uses provider "trackable"');
  });

  it("falls back to the supplied model or parent when no policy is installed", () => {
    const { pi, ctx, models } = fixture("trackable", ["auto", "claude-sonnet-4-6"]);
    expect(selectSpawnModel(pi, ctx, "Explore", undefined, models.sonnet).model).toBe(models.sonnet);
    expect(selectSpawnModel(pi, ctx, "Explore").model).toBe(models.auto);
  });

  it("rejects malformed decisions and unknown exact policy models", () => {
    const { pi, ctx } = fixture("trackable", ["auto"]);
    installPolicy(pi.events as unknown as PolicyEvents, (req) => {
      req.decision = { model: "trackable/auto", source: "explicit", error: "no" } as never;
    });
    expect(() => selectSpawnModel(pi, ctx, "Explore")).toThrow("Invalid subagent policy decision");

    installPolicy(pi.events as unknown as PolicyEvents, (req) => {
      req.decision = { model: "trackable/missing", source: "explicit" };
    });
    expect(() => selectSpawnModel(pi, ctx, "Explore"))
      .toThrow('Subagent policy model not found: "trackable/missing"');
  });
});
