import { isAbsolute, resolve } from "node:path";
import type { BackendRouter, FileSymbols, Workspace } from "@symnav/core";
import { validateOverviewTarget } from "./validate-overview-target.js";

export interface RunOverviewArgs {
  workspace: Workspace;
  router: BackendRouter;
  cwd: string;
  inputPath: string;
}

export async function runOverview(args: RunOverviewArgs): Promise<FileSymbols> {
  const absolutePath = isAbsolute(args.inputPath)
    ? args.inputPath
    : resolve(args.cwd, args.inputPath);
  const { relativePath, backend } = await validateOverviewTarget({
    workspace: args.workspace,
    router: args.router,
    absolutePath,
  });
  return backend.fileSymbols(relativePath);
}
