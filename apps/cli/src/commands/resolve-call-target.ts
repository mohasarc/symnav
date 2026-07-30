import type {
  LanguageBackend,
  ResolvedPath,
  SymbolOverviewNode,
  SymbolIdentity,
} from "@symnav/core";
import { AmbiguousSymbolError, SymbolNotFoundError } from "@symnav/core";

export async function resolveCallTarget(
  backend: LanguageBackend,
  files: readonly ResolvedPath[],
  identity: SymbolIdentity,
): Promise<SymbolOverviewNode> {
  const resolution = await backend.findCallTarget(files, identity);
  if (resolution.outcome === "not-found") {
    throw new SymbolNotFoundError(identity);
  }
  if (resolution.outcome === "ambiguous") {
    throw new AmbiguousSymbolError(identity, resolution.candidates);
  }
  return resolution.target;
}
