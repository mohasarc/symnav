import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { FixtureRunner } from "../fixture-runner.js";

const runner = new FixtureRunner("overview-cases");
const snapshotsDir = fileURLToPath(new URL("./__snapshots__/", import.meta.url));
const leakyFunctionId = "collapsed-headers.ts::leakyFunction";

function snapshot(name: string): string {
  return join(snapshotsDir, name);
}

function runSymnav(args: readonly string[]) {
  return runner.run(args);
}

function allHeaderLines(entries: readonly OverviewNode[]): string[] {
  return entries.flatMap((entry) => [
    ...entry.header.lines,
    ...allHeaderLines(entry.children ?? []),
  ]);
}

type OverviewNode = {
  type: string;
  header: { lines: readonly string[] };
  children?: readonly OverviewNode[];
};

describe("symnav overview e2e (collapsed headers)", () => {
  it("renders collapsed text headers without leaking declarations or initializer bodies", async () => {
    const r = runSymnav(["overview", "collapsed-headers.ts", "--depth", "1"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("HeaderContract::readHeader");
    expect(r.stdout).toContain("HeaderNamespace::defaultName");
    expect(r.stdout).toContain("HeaderNamespace::normalizeName");
    expect(r.stdout).toContain("HeaderService::prefix");
    expect(r.stdout).toContain("HeaderService::constructor");
    expect(r.stdout).toContain("HeaderService::label");
    expect(r.stdout).toContain("HeaderService::readHeader");
    expect(r.stdout).toContain("get label(): string");
    expect(r.stdout).toContain("export function leakyFunction(input: string): string");
    expect(r.stdout).toContain("export class HeaderService implements HeaderContract");
    expect(r.stdout).toContain("export interface HeaderContract");
    expect(r.stdout).toContain("export type HeaderAlias = {");
    expect(r.stdout).toContain("export enum HeaderMode");
    expect(r.stdout).toContain("export namespace HeaderNamespace");
    expect(r.stdout).toContain("export function overloads(input: string): string");
    expect(r.stdout).toContain("export const arrowHelper = (value: string): string => …");
    expect(r.stdout).toContain("export const schema = z.object(…)");
    expect(r.stdout).toContain("export const values = […]");
    expect(r.stdout).toContain("export { bareExported };");
    expect(r.stdout).toContain("export default function defaultHeader(name: string): string");
    expect(r.stdout).not.toContain("name.toLowerCase");
    expect(r.stdout).not.toContain("JSDoc that should never leak");
    expect(r.stdout).not.toContain("return input.toUpperCase");
    expect(r.stdout).not.toContain("throw new Error");
    expect(r.stdout).not.toContain("privateKey");
    expect(r.stdout).not.toContain("shouldStayHidden");
    expect(r.stdout).not.toContain("array-body-alpha");
    await expect(r.stdout).toMatchFileSnapshot(snapshot("collapsed-headers.expected.txt"));
  });

  it("renders top-level collapsed text headers only at depth zero", async () => {
    const r = runSymnav(["overview", "collapsed-headers.ts"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("export class HeaderService implements HeaderContract");
    expect(r.stdout).toContain("export interface HeaderContract");
    expect(r.stdout).toContain("export namespace HeaderNamespace");
    expect(r.stdout).not.toContain("HeaderContract::readHeader");
    expect(r.stdout).not.toContain("HeaderNamespace::defaultName");
    expect(r.stdout).not.toContain("HeaderService::label");
    expect(r.stdout).not.toContain("HeaderService::readHeader");
    await expect(r.stdout).toMatchFileSnapshot(snapshot("collapsed-headers-depth-0.expected.txt"));
  });

  it("renders collapsed JSON headers with discriminated node types", async () => {
    const r = runSymnav(["overview", "collapsed-headers.ts", "--depth", "1", "--json"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as { entries: readonly OverviewNode[] };
    const nodeTypes = new Set(parsed.entries.flatMap((entry) => collectNodeTypes(entry)));
    const headers = allHeaderLines(parsed.entries).join("\n");

    expect(nodeTypes).toEqual(new Set(["symbol", "re-export"]));
    expect(headers).toContain("readHeader(name: string): string");
    expect(headers).toContain("get label(): string");
    expect(headers).toContain("export const arrowHelper = (value: string): string => …");
    expect(headers).toContain("export const schema = z.object(…)");
    expect(headers).toContain("export const values = […]");
    expect(headers).not.toContain("JSDoc that should never leak");
    expect(headers).not.toContain("return input.toUpperCase");
    expect(headers).not.toContain("throw new Error");
    expect(headers).not.toContain("privateKey");
    expect(headers).not.toContain("array-body-alpha");
    await expect(r.stdout).toMatchFileSnapshot(snapshot("collapsed-headers.expected.json"));
  });

  it("renders every top-level JSON node without children at depth zero", async () => {
    const r = runSymnav(["overview", "collapsed-headers.ts", "--json"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as { entries: readonly OverviewNode[] };

    expect(parsed.entries.length).toBeGreaterThan(0);
    for (const entry of parsed.entries) {
      expect(entry.children ?? []).toEqual([]);
    }
    await expect(r.stdout).toMatchFileSnapshot(snapshot("collapsed-headers-depth-0.expected.json"));
  });
});

describe("symnav e2e (collapsed definition and reference previews)", () => {
  it("renders def without JSDoc or body leakage", async () => {
    const r = runSymnav(["def", leakyFunctionId]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("export function leakyFunction(input: string): string");
    expect(r.stdout).not.toContain("JSDoc that should never leak");
    expect(r.stdout).not.toContain("return input.toUpperCase");
    expect(r.stdout).not.toContain("throw new Error");
    await expect(r.stdout).toMatchFileSnapshot(snapshot("collapsed-headers-def.expected.txt"));
  });

  it("renders context definition and caller preview from collapsed headers", async () => {
    const r = runSymnav(["context", leakyFunctionId]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("export function leakyFunction(input: string): string");
    expect(r.stdout).toContain("callsLeakyFunction  [call]");
    expect(r.stdout).toContain('return leakyFunction("visible-call");');
    expect(r.stdout).not.toContain("JSDoc that should never leak");
    expect(r.stdout).not.toContain("throw new Error");
    await expect(r.stdout).toMatchFileSnapshot(snapshot("collapsed-headers-context.expected.txt"));
  });

  it("renders the real call reference without treating declaration body as a reference", async () => {
    const r = runSymnav(["refs", leakyFunctionId]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('12: return leakyFunction("visible-call");  [usage]');
    expect(r.stdout).toContain("Total: 1");
    expect(r.stdout).not.toContain("return input.toUpperCase");
    expect(r.stdout).not.toContain("throw new Error");
    await expect(r.stdout).toMatchFileSnapshot(snapshot("collapsed-headers-refs.expected.txt"));
  });
});

function collectNodeTypes(node: OverviewNode): string[] {
  return [node.type, ...(node.children ?? []).flatMap((child) => collectNodeTypes(child))];
}
