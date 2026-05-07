import { Project, type SourceFile, ScriptTarget } from "ts-morph";

export function parseTs(source: string, fileName = "test.ts"): SourceFile {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      target: ScriptTarget.ES2022,
      allowJs: false,
    },
  });
  return project.createSourceFile(fileName, source);
}
