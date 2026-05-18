import type {
  DefinitionResult,
  LanguageBackend,
  ResolvedPath,
  SymbolDecl,
  SymbolIdentity,
} from "@symnav/core";
import { parseSymbolIdentity } from "@symnav/core";
import { renderDefinitionJson, renderDefinitionText } from "@symnav/renderer";

import type { Command, CommandContext } from "../../command.js";

export interface DefArgs {
  readonly symbolId: string;
}

export const defCommand: Command<DefinitionResult, DefArgs> = {
  async compute(ctx: CommandContext<DefArgs>): Promise<DefinitionResult> {
    const identity = parseSymbolIdentity(ctx.args.symbolId);
    await ctx.workspace.resolveInputPath(identity.file, ctx.cwd);
    const files = await ctx.workspace.enumerate();
    const owningBackend = ctx.router.findOrThrow(identity.file);
    const symbols = await callOwningBackend(owningBackend, files, identity);
    return { identity, symbols };
  },
  renderText: renderDefinitionText,
  renderJson: renderDefinitionJson,
};

async function callOwningBackend(
  backend: LanguageBackend,
  files: readonly ResolvedPath[],
  identity: SymbolIdentity,
): Promise<readonly SymbolDecl[]> {
  const accepted = files.filter((file) => backend.accepts(file.relative));
  return backend.findDefinitions(accepted, identity);
}
