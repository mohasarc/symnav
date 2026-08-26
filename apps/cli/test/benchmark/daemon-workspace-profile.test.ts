import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DaemonWorkspaceProfileValidator,
  type DaemonWorkspaceProfile,
  type DistributionSummary,
} from "./daemon-workspace-profile.js";

describe("daemon workspace profile", () => {
  it("accepts the reviewed versioned aggregate without proprietary identifiers", () => {
    const serialized = readFileSync(
      new URL("./profiles/daemon-workspace-1x.v1.json", import.meta.url),
      "utf8",
    );
    const profile = DaemonWorkspaceProfileValidator.parse(JSON.parse(serialized));

    expect(profile.schemaVersion).toBe(1);
    expect(profile.visibleTypeScriptFiles).toBeGreaterThanOrEqual(3_850);
    expect(profile.visibleTypeScriptFiles).toBeLessThanOrEqual(4_000);
    expect(serialized).not.toMatch(/(?:[A-Za-z]:\\|\/Users\/|\/home\/|::|[a-f\d]{40})/i);
  });

  it("rejects extra fields and invalid aggregate quantiles", () => {
    const valid = reviewedProfile();

    expect(() =>
      DaemonWorkspaceProfileValidator.parse({ ...valid, workspacePath: "/secret" }),
    ).toThrow("profile fields");
    expect(() =>
      DaemonWorkspaceProfileValidator.parse({
        ...valid,
        sourceBytes: { minimum: 10, p50: 9, p95: 20, maximum: 30 },
      }),
    ).toThrow("distribution");
  });
});

function reviewedProfile(): DaemonWorkspaceProfile {
  const distribution = (
    minimum: number,
    p50: number,
    p95: number,
    maximum: number,
  ): DistributionSummary => ({
    minimum,
    p50,
    p95,
    maximum,
  });
  return {
    schemaVersion: 1,
    profileVersion: "1.0.0",
    visibleTypeScriptFiles: 3_904,
    sourceBytes: distribution(1, 500, 2_000, 10_000),
    sourceLines: distribution(1, 20, 80, 400),
    symbolsPerFile: distribution(0, 3, 12, 50),
    packageCount: 20,
    configCount: 24,
    projectReferenceCount: 19,
    importsPerFile: distribution(0, 2, 8, 30),
    referenceFanout: distribution(0, 2, 10, 100),
    aliasImportRatio: 0.2,
    workspaceImportRatio: 0.1,
    callInDegree: distribution(0, 1, 6, 30),
    callOutDegree: distribution(0, 1, 6, 30),
    callDepth: distribution(0, 2, 5, 10),
    cycleRatio: 0.02,
    declarationKindCounts: { class: 100, function: 1_000 },
    representativeResultCounts: {
      overview: 10,
      resolve: 10,
      def: 1,
      refs: 20,
      context: 10,
      graph: 10,
      stats: 1,
      help: 0,
      version: 0,
      unknown: 0,
    },
    ignoredPathRatio: 0.05,
    nestedWorkspaceRatio: 0.01,
  };
}
