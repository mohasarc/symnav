import type { FileSymbols } from "../intermediate-representation/types.js";

export interface LanguageBackend {
  accepts(filePath: string): boolean;
  fileSymbols(filePath: string): Promise<FileSymbols>;
}
