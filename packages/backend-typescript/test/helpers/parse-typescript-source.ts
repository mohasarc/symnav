import { Project, ScriptTarget, type SourceFile } from "ts-morph";

export function parseTypeScriptSource(source: string, fileName?: string): SourceFile {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { target: ScriptTarget.ES2022, allowJs: false },
  });
  return project.createSourceFile(fileName ?? "input.ts", source);
}
