import type { BackendRouter, LanguageBackend, Workspace } from "@symnav/core";
import {
  FileNotFoundError,
  IgnoredFileError,
  OutsideWorkspaceError,
  UnsupportedFileError,
} from "@symnav/core";

export async function validateOverviewTarget(args: {
  workspace: Workspace;
  router: BackendRouter;
  absolutePath: string;
}): Promise<{ relativePath: string; backend: LanguageBackend }> {
  const { workspace, router, absolutePath } = args;
  if (!(await workspace.fs.exists(absolutePath))) {
    throw new FileNotFoundError();
  }
  if (!workspace.isInWorkspace(absolutePath)) {
    throw new OutsideWorkspaceError();
  }
  const relativePath = workspace.toRelative(absolutePath);
  if (workspace.isIgnored(relativePath)) {
    throw new IgnoredFileError();
  }
  const backend = router.find(relativePath);
  if (backend === undefined) {
    throw new UnsupportedFileError();
  }
  return { relativePath, backend };
}
