import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";

import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";

const fixtureRoot = fixturePath("extraction-v2-cases");
const snapshotsDir = new URL("./__snapshots__/", import.meta.url).pathname;
const buildWorkflowId = "src/agent-workflow.ts::buildWorkflow";
const unsupportedStatementWarning =
  "Warning: skipped unrecognised statement syntax at src/unsupported-statement.ts:5 (MissingDeclaration)\n";

interface JsonIdentity {
  file: string;
  segments: readonly { name: string }[];
}

interface JsonContextResult {
  identity: JsonIdentity;
  definitions: readonly unknown[];
  callers: unknown;
  callees: unknown;
  references: { total: number };
}

interface JsonGraphResult {
  identity: JsonIdentity;
  root: { identity: JsonIdentity };
  outgoing: { totalPathCount: number; paths: readonly unknown[] };
}

function snapshot(name: string): string {
  return join(snapshotsDir, name);
}

function runSymnav(args: readonly string[]) {
  return runSymnavBinary(args, { cwd: fixtureRoot });
}

function expectIdentity(identity: JsonIdentity, canonicalId: string): void {
  const [file, ...segments] = canonicalId.split("::");
  expect(identity).toEqual({
    file,
    segments: segments.map((name) => ({ name })),
  });
}

function copiedHeader(stdout: string, text: string): string {
  const line = stdout.split("\n").find((candidate) => candidate.includes(text));
  if (line === undefined) throw new Error(`Missing overview header containing ${text}`);

  const header = line.match(/\d+(?:-\d+)?: (.*)$/)?.[1];
  if (header === undefined) throw new Error(`Could not copy overview header from ${line}`);
  return header;
}

function copiedCandidate(stderr: string): string {
  const candidate = stderr.match(/src\/agent-workflow\.ts::[^\n]+/)?.[0];
  if (candidate === undefined) throw new Error("Could not copy ambiguous target candidate");
  return candidate;
}

function expectUnsupportedStatementWarning(stderr: string): void {
  expect(stderr).toBe(unsupportedStatementWarning);
}

beforeAll(() => {
  ensureFixtureGitMarker(fixtureRoot);
});

describe("symnav extraction v2 workflow smoke", () => {
  it("renders compact overview and expands a copied fold header", async () => {
    const overview = runSymnav(["overview", "src/agent-workflow.ts"]);
    expect(overview.stderr).toBe("");
    expect(overview.status).toBe(0);
    expect(overview.stdout).toContain("export function buildWorkflow(");
    expect(overview.stdout).toContain("if (defaultSteps.length > 0)");
    expect(overview.stdout).not.toContain("Workflow JSDoc should not leak");
    expect(overview.stdout).not.toContain("privateWorkflowSecret");
    expect(overview.stdout).not.toContain("return finalizeWorkflow");
    await expect(overview.stdout).toMatchFileSnapshot(
      snapshot("agent-workflow-overview.expected.txt"),
    );

    const overviewJson = runSymnav(["overview", "src/agent-workflow.ts", "--json"]);
    expect(overviewJson.stderr).toBe("");
    expect(overviewJson.status).toBe(0);
    expect(() => JSON.parse(overviewJson.stdout)).not.toThrow();

    const foldHeader = copiedHeader(overview.stdout, "if (defaultSteps.length > 0)");
    const targetedOverview = runSymnav([
      "overview",
      "src/agent-workflow.ts",
      "--at",
      foldHeader,
      "--depth",
      "1",
    ]);
    expect(targetedOverview.stderr).toBe("");
    expect(targetedOverview.status).toBe(0);
    expect(targetedOverview.stdout).toContain("buildNestedWorkflowAudit");
    await expect(targetedOverview.stdout).toMatchFileSnapshot(
      snapshot("agent-workflow-targeted-fold.expected.txt"),
    );
  });

  it("resolves own-name regex matches and follows a copied ambiguity candidate", async () => {
    const resolved = runSymnav(["resolve", "--regex", "^build[A-Z]"]);
    expectUnsupportedStatementWarning(resolved.stderr);
    expect(resolved.status).toBe(0);
    expect(resolved.stdout).toContain("src/agent-workflow.ts");
    expect(resolved.stdout).toContain("buildWorkflow");
    expect(resolved.stdout).toContain("AgentBuilder::buildTask");
    expect(resolved.stdout).toContain("WorkflowBuilder::buildTask");
    expect(resolved.stdout).not.toContain("BuildCoordinator::run");
    await expect(resolved.stdout).toMatchFileSnapshot(
      snapshot("agent-workflow-resolve.expected.txt"),
    );

    const uniqueDefinition = runSymnav(["def", "buildWorkflow"]);
    expectUnsupportedStatementWarning(uniqueDefinition.stderr);
    expect(uniqueDefinition.status).toBe(0);
    expect(uniqueDefinition.stdout).toContain("Definition: buildWorkflow");
    expect(uniqueDefinition.stdout).toContain("export function buildWorkflow(");

    const ambiguousDefinition = runSymnav(["def", "buildTask"]);
    expect(ambiguousDefinition.status).toBe(1);
    expect(ambiguousDefinition.stdout).toBe("");
    expect(ambiguousDefinition.stderr).toContain('symbol target "buildTask" is ambiguous');

    const copiedDefinition = runSymnav(["def", copiedCandidate(ambiguousDefinition.stderr)]);
    expectUnsupportedStatementWarning(copiedDefinition.stderr);
    expect(copiedDefinition.status).toBe(0);
    expect(copiedDefinition.stdout).toContain("Definition: AgentBuilder::buildTask");
  });

  it("keeps suffix-target pagination stable across runs", async () => {
    const firstReferences = runSymnav([
      "refs",
      "agent-workflow.ts::buildWorkflow",
      "--page-size",
      "2",
    ]);
    const secondReferences = runSymnav([
      "refs",
      "agent-workflow.ts::buildWorkflow",
      "--page-size",
      "2",
    ]);
    expectUnsupportedStatementWarning(firstReferences.stderr);
    expectUnsupportedStatementWarning(secondReferences.stderr);
    expect(firstReferences.status).toBe(0);
    expect(secondReferences.status).toBe(0);
    expect(secondReferences.stdout).toBe(firstReferences.stdout);
    expect(firstReferences.stdout).toContain("References: buildWorkflow");
    expect(firstReferences.stdout).toContain("Page: 1/");
    await expect(firstReferences.stdout).toMatchFileSnapshot(
      snapshot("agent-workflow-refs-page-1.expected.txt"),
    );
  });

  it("keeps JSON outputs parseable and routes diagnostics to stderr", () => {
    const context = runSymnav(["context", "buildWorkflow", "--json"]);
    expectUnsupportedStatementWarning(context.stderr);
    expect(context.status).toBe(0);
    const parsedContext = JSON.parse(context.stdout) as JsonContextResult;
    expectIdentity(parsedContext.identity, buildWorkflowId);
    expect(parsedContext.definitions.length).toBeGreaterThan(0);
    expect(parsedContext.callers).toBeDefined();
    expect(parsedContext.callees).toBeDefined();
    expect(parsedContext.references.total).toBeGreaterThan(0);

    const graph = runSymnav(["graph", "buildWorkflow", "--outgoing", "--depth", "2", "--json"]);
    expectUnsupportedStatementWarning(graph.stderr);
    expect(graph.status).toBe(0);
    const parsedGraph = JSON.parse(graph.stdout) as JsonGraphResult;
    expectIdentity(parsedGraph.identity, buildWorkflowId);
    expectIdentity(parsedGraph.root.identity, buildWorkflowId);
    expect(parsedGraph.outgoing.totalPathCount).toBeGreaterThan(0);
    expect(parsedGraph.outgoing.paths.length).toBeGreaterThan(0);

    const warningOverview = runSymnav(["overview", "src/unsupported-statement.ts"]);
    expect(warningOverview.status).toBe(0);
    expectUnsupportedStatementWarning(warningOverview.stderr);
    expect(warningOverview.stdout).toContain("stillVisible");
  });
});
