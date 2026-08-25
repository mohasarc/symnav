import { describe, expect, it } from "vitest";

import {
  TypeScriptBackend,
  TypeScriptWorkspaceState,
  type TypeScriptFileExtractionRequest,
  type TypeScriptFileExtractor,
} from "@symnav/backend-typescript";
import {
  BackendRouter,
  createWorkspace,
  InMemoryFileSystem,
  type ResultWithDiagnostics,
} from "@symnav/core";

import { NavigationDiagnosticsCollector } from "./navigation-diagnostics-collector.js";

class CountingDiagnosticExtractor implements TypeScriptFileExtractor {
  readonly calls: string[] = [];

  extract(request: TypeScriptFileExtractionRequest) {
    this.calls.push(request.filePath);
    request.diagnostics?.report({
      severity: "warning",
      dedupeKey: request.filePath,
      message: `warning from ${request.filePath}`,
    });
    return { file: request.filePath, entries: [] };
  }
}

describe("NavigationDiagnosticsCollector", () => {
  it("collects prepared diagnostics in workspace order without re-extracting files", async () => {
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/z.ts": "export const z = true;\n",
      "/repo/src/a.ts": "export const a = true;\n",
    });
    const extractor = new CountingDiagnosticExtractor();
    const backend = new TypeScriptBackend(fs, new TypeScriptWorkspaceState(fs, extractor));
    const router = new BackendRouter([backend]);
    const workspace = await createWorkspace({ startDir: "/repo", fs });
    await router.refresh(await workspace.snapshot());

    const result: ResultWithDiagnostics = {};
    const first = await NavigationDiagnosticsCollector.attach(result, workspace, router);
    const second = await NavigationDiagnosticsCollector.attach(result, workspace, router);

    expect(first.diagnostics?.map((diagnostic) => diagnostic.message)).toEqual([
      "warning from src/a.ts",
      "warning from src/z.ts",
    ]);
    expect(second).toEqual(first);
    expect(extractor.calls).toEqual(["src/a.ts", "src/z.ts"]);
  });
});
