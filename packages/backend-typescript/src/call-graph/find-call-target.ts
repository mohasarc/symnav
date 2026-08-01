import type {
  CallTargetResolution,
  ResolvedPath,
  SymbolOverviewNode,
  SymbolIdentity,
} from "@symnav/core";

import type { WorkspaceDeclarationIndex } from "../identity/workspace-declaration-index.js";
import { findDefinitions } from "../definition/find-definitions.js";

export interface FindCallTargetArgs {
  readonly index: WorkspaceDeclarationIndex;
  readonly files: readonly ResolvedPath[];
  readonly identity: SymbolIdentity;
}

export async function findCallTarget(args: FindCallTargetArgs): Promise<CallTargetResolution> {
  const definitions = await findDefinitions(args);
  if (definitions.length === 0) return { outcome: "not-found" };
  const implementations = definitions.filter(carriesBody);
  if (implementations.length > 1) {
    return { outcome: "ambiguous", candidates: implementations };
  }
  if (implementations.length === 1) {
    return { outcome: "resolved", target: implementations[0]! };
  }
  return { outcome: "resolved", target: definitions[0]! };
}

function carriesBody(declaration: SymbolOverviewNode): boolean {
  return declaration.kind.nativeLabel.endsWith("-implementation");
}
