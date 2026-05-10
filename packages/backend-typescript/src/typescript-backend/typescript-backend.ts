import type { FileSymbols, LanguageBackend, Workspace } from "@symnav/core";

import { acceptsTypeScriptFile } from "./typescript-extensions.js";

export class TypeScriptBackend implements LanguageBackend {
  constructor(private readonly workspace: Workspace) {}

  accepts(filePath: string): boolean {
    return acceptsTypeScriptFile(filePath);
  }

  async fileSymbols(_filePath: string): Promise<FileSymbols> {
    void this.workspace;
    throw new Error("TypeScriptBackend.fileSymbols not implemented");
  }
}
