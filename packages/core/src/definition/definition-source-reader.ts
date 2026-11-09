import type { DefinitionSource, LineRange } from "../intermediate-representation/types.js";
import type { FileSystem } from "../workspace/file-system.js";
import type { ResolvedPath } from "../workspace/workspace.js";

const LINE_BREAK = /\r?\n/;

export class DefinitionSourceReader {
  constructor(private readonly fileSystem: FileSystem) {}

  async read(path: ResolvedPath, range: LineRange): Promise<DefinitionSource> {
    const content = await this.fileSystem.readFile(path.absolute);
    const lines = content.split(LINE_BREAK).slice(range.startLine - 1, range.endLine);
    return { startLine: range.startLine, lines };
  }
}
