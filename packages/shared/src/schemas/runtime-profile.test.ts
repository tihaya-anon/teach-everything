import { describe, expect, it } from "vitest";
import developmentProfileDocument from "../../../../profiles/runtime-development.json";
import publishedProfileDocument from "../../../../profiles/runtime-published.json";
import {
  agentBehaviorVersionSchema,
  strictAgentBehaviorVersionSchema,
  runtimeProfileSchema,
  validateAgentBehaviorVersionForRuntimeProfile,
} from "../index";

const defaultProfileDocuments = {
  "runtime-development": developmentProfileDocument,
  "runtime-published": publishedProfileDocument,
} as const;

const completeBehaviorVersion = {
  graph: "graph:teaching-assistant:v1",
  state: "state:lesson-session:v1",
  action: "action:tutor-response:v1",
  prompt: "prompt:socratic:v3",
  tool: "tool:retrieval:v2",
  model: "model:openai:gpt-5:2026-07-20",
  trialParameter: "trial-parameter:baseline:v1",
  sourceRevision: "0123456789abcdef0123456789abcdef01234567",
} as const;

describe("runtimeProfileSchema", () => {
  it.each(["runtime-development", "runtime-published"] as const)(
    "accepts the default %s profile document",
    (profileName) => {
      // Given
      const profileDocument = defaultProfileDocuments[profileName];

      // When
      const result = runtimeProfileSchema.safeParse(profileDocument);

      // Then
      expect(result.success).toBe(true);
    },
  );

  it.each([
    {},
    {
      schemaVersion: 1,
      profileId: "published",
      runtimePolicy: {
        agentBehaviorVersion: {
          policy: "strict",
          requireCompleteDimensions: false,
          rejectUnresolvedDimensions: true,
          allowIncompleteAdHocRuns: false,
        },
        sourceRevision: { requireCleanForPublishedGraphVersions: true },
      },
    },
    {
      schemaVersion: 1,
      profileId: "development",
      runtimePolicy: {
        agentBehaviorVersion: {
          policy: "development",
          requireCompleteDimensions: false,
          rejectUnresolvedDimensions: false,
          allowIncompleteAdHocRuns: true,
          incompleteAdHocRuns: { comparable: true, promotable: false },
        },
        sourceRevision: { requireCleanForPublishedGraphVersions: false },
      },
    },
    {
      schemaVersion: 1,
      profileId: "development",
      runtimePolicy: {
        agentBehaviorVersion: {
          policy: "development",
          requireCompleteDimensions: false,
          rejectUnresolvedDimensions: false,
          allowIncompleteAdHocRuns: true,
        },
        sourceRevision: { requireCleanForPublishedGraphVersions: false },
      },
    },
  ])("rejects a malformed policy document: %j", (profileDocument) => {
    // Given
    const malformedProfileDocument: unknown = profileDocument;

    // When
    const result = runtimeProfileSchema.safeParse(malformedProfileDocument);

    // Then
    expect(result.success).toBe(false);
  });

  it("represents incomplete development ad hoc runs as non-comparable and non-promotable", () => {
    // Given
    const profileDocument = developmentProfileDocument;

    // When
    const result = runtimeProfileSchema.safeParse(profileDocument);

    // Then
    expect(result).toMatchObject({
      success: true,
      data: {
        runtimePolicy: {
          agentBehaviorVersion: {
            allowIncompleteAdHocRuns: true,
            incompleteAdHocRuns: {
              comparable: false,
              promotable: false,
            },
          },
        },
      },
    });
  });
});

describe("agentBehaviorVersionSchema", () => {
  it("accepts a complete Agent Behavior Version tuple", () => {
    // Given
    const behaviorVersion: unknown = completeBehaviorVersion;

    // When
    const result = agentBehaviorVersionSchema.safeParse(behaviorVersion);

    // Then
    expect(result).toMatchObject({ success: true, data: completeBehaviorVersion });
  });

  it.each([
    "graph",
    "state",
    "action",
    "prompt",
    "tool",
    "model",
    "trialParameter",
    "sourceRevision",
  ] as const)("rejects a tuple missing the %s dimension", (dimension) => {
    // Given
    const behaviorVersion: Partial<typeof completeBehaviorVersion> = { ...completeBehaviorVersion };
    delete behaviorVersion[dimension];

    // When
    const result = agentBehaviorVersionSchema.safeParse(behaviorVersion);

    // Then
    expect(result.success).toBe(false);
  });

  it.each(["none", "unknown", "unresolved"])(
    "rejects the unresolved %j dimension value in strict policy",
    (unresolvedValue) => {
      // Given
      const behaviorVersion = { ...completeBehaviorVersion, prompt: unresolvedValue };

      // When
      const result = strictAgentBehaviorVersionSchema.safeParse(behaviorVersion);

      // Then
      expect(result.success).toBe(false);
    },
  );

  it("rejects a padded unresolved dimension value in strict policy", () => {
    // Given
    const behaviorVersion = { ...completeBehaviorVersion, prompt: " unknown " };

    // When
    const result = strictAgentBehaviorVersionSchema.safeParse(behaviorVersion);

    // Then
    expect(result.success).toBe(false);
  });

  it("selects strict validation from a strict Runtime Profile", () => {
    // Given
    const runtimeProfile = runtimeProfileSchema.parse(publishedProfileDocument);
    const behaviorVersion = { ...completeBehaviorVersion, tool: "none" };

    // When
    const result = validateAgentBehaviorVersionForRuntimeProfile(runtimeProfile, behaviorVersion);

    // Then
    expect(result.success).toBe(false);
  });

  it("selects incomplete ad hoc validation from a development Runtime Profile", () => {
    // Given
    const runtimeProfile = runtimeProfileSchema.parse(developmentProfileDocument);
    const behaviorVersion = {
      graph: "graph:local-scratch",
      sourceRevision: "unknown",
    };

    // When
    const result = validateAgentBehaviorVersionForRuntimeProfile(runtimeProfile, behaviorVersion);

    // Then
    expect(result).toMatchObject({
      success: true,
      data: behaviorVersion,
    });
  });
});
