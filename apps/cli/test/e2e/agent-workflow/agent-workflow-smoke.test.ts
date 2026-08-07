import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { expectIdentity } from "../expect-identity.js";
import { FixtureRunner } from "../fixture-runner.js";
import type { JsonIdentity } from "../json-identity.js";

const fixtureRunner = new FixtureRunner("agent-workflow-cases");
const snapshotsDir = new URL("./__snapshots__/", import.meta.url).pathname;
const buildWorkflowId = "src/agent-workflow.ts::buildWorkflow";
const buildWorkflowSuffixTarget = "agent-workflow.ts::buildWorkflow";

interface JsonResolvedTarget {
  identity: JsonIdentity;
}

interface JsonReference {
  file: string;
  line: number;
  matchStart: number;
}

interface JsonRefsResult extends JsonResolvedTarget {
  references: readonly JsonReference[];
}

interface JsonContextResult extends JsonResolvedTarget {
  definitions: readonly unknown[];
  callers: { sortedEdges: readonly unknown[] };
  callees: { sortedEdges: readonly unknown[] };
  references: { total: number };
}

interface JsonGraphResult extends JsonResolvedTarget {
  root: { identity: JsonIdentity };
  incoming: { totalPathCount: number; paths: readonly unknown[] };
  outgoing: { totalPathCount: number; paths: readonly unknown[] };
}

function snapshot(name: string): string {
  return join(snapshotsDir, name);
}

function runSymnav(args: readonly string[]) {
  return fixtureRunner.run(args);
}

function runReferencesPage(page: number) {
  return runSymnav(["refs", buildWorkflowSuffixTarget, "--page-size", "2", "--page", String(page)]);
}

function referencesOnPage(page: number): readonly JsonReference[] {
  const result = runSymnav([
    "refs",
    buildWorkflowSuffixTarget,
    "--page-size",
    "2",
    "--page",
    String(page),
    "--json",
  ]);
  expect(result.status).toBe(0);
  return (JSON.parse(result.stdout) as JsonRefsResult).references;
}

function allReferences(): readonly JsonReference[] {
  const result = runSymnav(["refs", buildWorkflowSuffixTarget, "--all", "--json"]);
  expect(result.status).toBe(0);
  return (JSON.parse(result.stdout) as JsonRefsResult).references;
}

function referenceKey(reference: JsonReference): string {
  return `${reference.file}:${reference.line}:${reference.matchStart}`;
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

describe("symnav agent workflow smoke", () => {
  it("renders compact overview and expands a copied fold header", async () => {
    const overview = runSymnav(["overview", "src/agent-workflow.ts"]);
    expect(overview.stderr).toBe("");
    expect(overview.status).toBe(0);
    expect(overview.stdout).toContain("export function buildWorkflow(");
    expect(overview.stdout).toContain("if (defaultSteps.length > 0)");
    expect(overview.stdout).not.toContain("Workflow JSDoc should not leak");
    expect(overview.stdout).not.toContain("privateWorkflowSecret");
    expect(overview.stdout).not.toContain("return finalizeWorkflow");
    expect(overview.stdout).toContain("for (const step of plan.steps) {");
    expect(overview.stdout).toContain("for (let index = 0; index < parts.length; index += 1) {");
    expect(overview.stdout).toContain("while (parts.length > 3) {");
    expect(overview.stdout).toContain("switch (plan.title) {");
    expect(overview.stdout).toContain("workflowAuditor::auditStep");
    expect(overview.stdout).toContain(
      [
        "│   108 export function describeWorkflowPlan(",
        "│   109   plan: WorkflowPlan,",
        "│   110   assignedAgent: string,",
        "│   111   includeSteps: boolean,",
        "│   112 ): string",
      ].join("\n"),
    );
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
    expect(resolved.stderr).toBe("");
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
    expect(uniqueDefinition.stderr).toBe("");
    expect(uniqueDefinition.status).toBe(0);
    expect(uniqueDefinition.stdout).toContain("Definition: buildWorkflow");
    expect(uniqueDefinition.stdout).toContain("export function buildWorkflow(");

    const ambiguousDefinition = runSymnav(["def", "buildTask"]);
    expect(ambiguousDefinition.status).toBe(1);
    expect(ambiguousDefinition.stdout).toBe("");
    await expect(ambiguousDefinition.stderr).toMatchFileSnapshot(
      snapshot("ambiguous-build-task.expected.err"),
    );

    const copiedDefinition = runSymnav(["def", copiedCandidate(ambiguousDefinition.stderr)]);
    expect(copiedDefinition.stderr).toBe("");
    expect(copiedDefinition.status).toBe(0);
    expect(copiedDefinition.stdout).toContain("Definition: AgentBuilder::buildTask");

    const overloadDefinition = runSymnav(["def", "WorkflowRouter::dispatch#1", "--json"]);
    expect(overloadDefinition.stderr).toBe("");
    expect(overloadDefinition.status).toBe(0);
    expectIdentity(
      (JSON.parse(overloadDefinition.stdout) as JsonResolvedTarget).identity,
      "src/agent-workflow.ts::WorkflowRouter::dispatch#1",
    );

    const initializerNestedDefinition = runSymnav(["def", "auditStep", "--json"]);
    expect(initializerNestedDefinition.stderr).toBe("");
    expect(initializerNestedDefinition.status).toBe(0);
    expectIdentity(
      (JSON.parse(initializerNestedDefinition.stdout) as JsonResolvedTarget).identity,
      "src/agent-workflow.ts::workflowAuditor::auditStep",
    );
  });

  it("walks every suffix-target page and repeats byte-identically", async () => {
    const firstReferences = runReferencesPage(1);
    const secondReferences = runReferencesPage(1);
    expect(firstReferences.stderr).toBe("");
    expect(secondReferences.stderr).toBe("");
    expect(firstReferences.status).toBe(0);
    expect(secondReferences.status).toBe(0);
    expect(secondReferences.stdout).toBe(firstReferences.stdout);
    expect(firstReferences.stdout).toContain("References: buildWorkflow");
    expect(firstReferences.stdout).toContain("Page: 1/3");
    await expect(firstReferences.stdout).toMatchFileSnapshot(
      snapshot("agent-workflow-refs-page-1.expected.txt"),
    );

    const pages = [1, 2, 3].map((page) => referencesOnPage(page));
    expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);

    const walkedKeys = pages.flat().map(referenceKey);
    expect(new Set(walkedKeys).size).toBe(walkedKeys.length);
    expect(walkedKeys).toEqual(allReferences().map(referenceKey));
  });

  it.skip("nests every reference under its enclosing symbols (refs lists them flat under the file today)", () => {
    const references = runSymnav(["refs", buildWorkflowSuffixTarget, "--all"]);
    expect(references.stdout).toBe(
      [
        "References: buildWorkflow",
        "Total: 5",
        "Kinds: usage 4, export 1",
        "Page: 1/1",
        "Sort: path, line",
        "",
        "src/",
        "├── agent-workflow-barrel.ts",
        '│   └── 1: export { buildWorkflow, workflowFactory } from "./agent-workflow";  [export]',
        "└── agent-workflow.ts",
        "    ├── 29-33: BuildCoordinator",
        "    │   └── 30-32: BuildCoordinator::run",
        "    │       └── 31: return buildWorkflow(defaultWorkflowInput());  [usage]",
        "    ├── 88-90: runAgentWorkflow",
        "    │   └── 89: return buildWorkflow(defaultWorkflowInput());  [usage]",
        "    ├── 92-96: previewAgentWorkflow",
        "    │   └── 93: previewAgentWorkflow::plan",
        '    │       └── 93: const plan = buildWorkflow({ ...defaultWorkflowInput(), mode: "draft" });  [usage]',
        "    └── 98: workflowFactory",
        "        └── 98: …workflowFactory = (input: WorkflowInput): WorkflowPlan => buildWorkflow(input);  [usage]",
        "",
      ].join("\n"),
    );
  });

  it("keeps context and graph JSON parseable with a clean stderr", () => {
    const context = runSymnav(["context", "buildWorkflow", "--json"]);
    expect(context.stderr).toBe("");
    expect(context.status).toBe(0);
    const parsedContext = JSON.parse(context.stdout) as JsonContextResult;
    expectIdentity(parsedContext.identity, buildWorkflowId);
    expect(parsedContext.definitions.length).toBeGreaterThan(0);
    expect(parsedContext.callers.sortedEdges).toHaveLength(4);
    expect(parsedContext.callees.sortedEdges).toHaveLength(4);
    expect(parsedContext.references.total).toBeGreaterThan(0);

    const graph = runSymnav(["graph", "buildWorkflow", "--outgoing", "--depth", "2", "--json"]);
    expect(graph.stderr).toBe("");
    expect(graph.status).toBe(0);
    const parsedGraph = JSON.parse(graph.stdout) as JsonGraphResult;
    expectIdentity(parsedGraph.identity, buildWorkflowId);
    expectIdentity(parsedGraph.root.identity, buildWorkflowId);
    expect(parsedGraph.outgoing.totalPathCount).toBeGreaterThan(0);
    expect(parsedGraph.outgoing.paths.length).toBeGreaterThan(0);

    const incomingGraph = runSymnav(["graph", "buildWorkflow", "--incoming", "--json"]);
    expect(incomingGraph.stderr).toBe("");
    expect(incomingGraph.status).toBe(0);
    const parsedIncomingGraph = JSON.parse(incomingGraph.stdout) as JsonGraphResult;
    expectIdentity(parsedIncomingGraph.identity, buildWorkflowId);
    expect(parsedIncomingGraph.incoming.totalPathCount).toBe(4);
    expect(parsedIncomingGraph.incoming.paths.length).toBe(4);
  });

  it("renders context and both graph directions", async () => {
    const context = runSymnav(["context", "buildWorkflow"]);
    expect(context.stderr).toBe("");
    expect(context.status).toBe(0);
    await expect(context.stdout).toMatchFileSnapshot(
      snapshot("agent-workflow-context.expected.txt"),
    );

    const outgoingGraph = runSymnav(["graph", "buildWorkflow", "--outgoing", "--depth", "2"]);
    expect(outgoingGraph.stderr).toBe("");
    expect(outgoingGraph.status).toBe(0);
    await expect(outgoingGraph.stdout).toMatchFileSnapshot(
      snapshot("agent-workflow-graph-outgoing.expected.txt"),
    );

    const incomingGraph = runSymnav(["graph", "buildWorkflow", "--incoming"]);
    expect(incomingGraph.stderr).toBe("");
    expect(incomingGraph.status).toBe(0);
    await expect(incomingGraph.stdout).toMatchFileSnapshot(
      snapshot("agent-workflow-graph-incoming.expected.txt"),
    );
  });
});
