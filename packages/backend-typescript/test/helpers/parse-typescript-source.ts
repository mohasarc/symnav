import { Project, type SourceFile } from "ts-morph";

export function parseTypeScriptSource(source: string, fileName?: string): SourceFile {
  const project = new Project({
    useInMemoryFileSystem: true,
  });
  return project.createSourceFile(fileName ?? "input.ts", source);
}
