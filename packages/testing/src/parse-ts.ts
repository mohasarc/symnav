import { Project, type SourceFile } from "ts-morph";

/**
 * Parse a TypeScript source string in an in-memory ts-morph project and return
 * the resulting `SourceFile`. Used by unit tests of the TypeScript backend's
 * pure layer so they can exercise the extraction helpers without touching disk
 * or constructing a `Workspace`.
 *
 * `fileName` defaults to `"test.ts"`; callers can override it (e.g. `"test.tsx"`,
 * `"decls.d.ts"`) when the file extension changes how ts-morph parses the input.
 */
export function parseTs(source: string, fileName = "test.ts"): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile(fileName, source);
}
