import type { FileSymbols, LanguageBackend, Workspace } from "@symnav/core";

import { extractFileSymbols } from "../extract/extract-file-symbols.js";
import { loadSourceFile } from "./load-source-file.js";
import { acceptsTypeScriptFile } from "./typescript-extensions.js";

export class TypeScriptBackend implements LanguageBackend {
  constructor(private readonly workspace: Workspace) {}

  accepts(filePath: string): boolean {
    return acceptsTypeScriptFile(filePath);
  }

  async fileSymbols(filePath: string): Promise<FileSymbols> {
    const absolutePath = this.workspace.toAbsolute(filePath);
    const sourceFile = loadSourceFile({ fs: this.workspace.fs, absolutePath });
    return extractFileSymbols({ sourceFile, filePath });
  }
}
