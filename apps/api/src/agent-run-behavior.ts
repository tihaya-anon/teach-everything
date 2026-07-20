import {
  strictAgentBehaviorVersionSchema,
  type AgentBehaviorVersion,
  type DevelopmentAgentBehaviorVersion,
  type RuntimeProfile,
  type StrictAgentBehaviorVersion,
  runtimeProfileSchema,
  validateAgentBehaviorVersionForRuntimeProfile,
} from "@teach-everything/shared";
import type { AgentRunAcceptedTelemetry } from "@teach-everything/observability";

export type AgentBehaviorVersionAcceptanceConfig = {
  agentBehaviorVersion: unknown;
  runtimeProfile: unknown;
};

export type AgentBehaviorVersionAcceptanceInput = {
  agentBehaviorVersion: unknown;
  runtimeProfile: RuntimeProfile;
};

type AgentBehaviorVersionAccepted = {
  acceptedTelemetry: AgentRunAcceptedTelemetry;
  success: true;
};

type AgentBehaviorVersionRejected = {
  success: false;
};

export type AgentBehaviorVersionAcceptance =
  AgentBehaviorVersionAccepted | AgentBehaviorVersionRejected;

export const DEFAULT_DEVELOPMENT_AGENT_BEHAVIOR_VERSION = {
  graph: "graph:local-ad-hoc",
  sourceRevision: "unknown",
} satisfies DevelopmentAgentBehaviorVersion;

export const validateAgentBehaviorVersionAcceptanceConfig = ({
  agentBehaviorVersion,
  runtimeProfile,
}: AgentBehaviorVersionAcceptanceConfig): AgentBehaviorVersionAcceptanceInput => ({
  agentBehaviorVersion,
  runtimeProfile: runtimeProfileSchema.parse(runtimeProfile),
});

const isCompleteBehaviorVersion = (
  behaviorVersion: DevelopmentAgentBehaviorVersion,
): behaviorVersion is StrictAgentBehaviorVersion =>
  strictAgentBehaviorVersionSchema.safeParse(behaviorVersion).success;

const acceptedTelemetry = (
  runtimeProfile: RuntimeProfile,
  agentBehaviorVersion: AgentBehaviorVersion | DevelopmentAgentBehaviorVersion,
  comparable: boolean,
  promotable: boolean,
): AgentRunAcceptedTelemetry => ({
  agentBehaviorVersion,
  comparable,
  promotable,
  runtimeProfileId: runtimeProfile.profileId,
});

export const resolveAgentBehaviorVersionAcceptance = ({
  agentBehaviorVersion,
  runtimeProfile,
}: AgentBehaviorVersionAcceptanceInput): AgentBehaviorVersionAcceptance => {
  const policy = runtimeProfile.runtimePolicy.agentBehaviorVersion;
  const parsedBehaviorVersion = validateAgentBehaviorVersionForRuntimeProfile(
    runtimeProfile,
    agentBehaviorVersion,
  );
  if (!parsedBehaviorVersion.success) return { success: false };

  if (policy.policy === "strict") {
    return {
      acceptedTelemetry: acceptedTelemetry(runtimeProfile, parsedBehaviorVersion.data, true, true),
      success: true,
    };
  }

  if (!isCompleteBehaviorVersion(parsedBehaviorVersion.data)) {
    return {
      acceptedTelemetry: acceptedTelemetry(
        runtimeProfile,
        parsedBehaviorVersion.data,
        policy.incompleteAdHocRuns.comparable,
        policy.incompleteAdHocRuns.promotable,
      ),
      success: true,
    };
  }

  return {
    acceptedTelemetry: acceptedTelemetry(runtimeProfile, parsedBehaviorVersion.data, true, true),
    success: true,
  };
};
