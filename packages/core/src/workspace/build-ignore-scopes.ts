import ignore from "ignore";
import { posix } from "node:path";
import type { WorkspaceFileSystem } from "./file-system.js";
import type { IgnoreScope } from "./ignore-scope.js";
import { isIgnoredByScopes } from "./is-ignored-by-scopes.js";
import { relPathFromRoot } from "./rel-path-from-root.js";

export function buildIgnoreScopes(root: string, fs: WorkspaceFileSystem): IgnoreScope[] {
  const scopes: IgnoreScope[] = [];
  walkGitignores(root, root, fs, scopes);
  return scopes;
}

function walkGitignores(
  dirAbs: string,
  root: string,
  fs: WorkspaceFileSystem,
  scopes: IgnoreScope[],
): void {
  const dirRelToRoot = relPathFromRoot(dirAbs, root);
  const gitignorePath = posix.join(dirAbs, ".gitignore");
  if (fs.existsSync(gitignorePath) && !fs.isDirectorySync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath);
    scopes.push({ dirRelToRoot, matcher: ignore().add(content) });
  }
  let entries: readonly string[];
  try {
    entries = fs.listDirSync(dirAbs);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === ".git") {
      continue;
    }
    const childAbs = posix.join(dirAbs, entry);
    if (!fs.isDirectorySync(childAbs)) {
      continue;
    }
    const childRelToRoot = dirRelToRoot === "" ? entry : `${dirRelToRoot}/${entry}`;
    if (isIgnoredByScopes(`${childRelToRoot}/`, scopes)) {
      continue;
    }
    walkGitignores(childAbs, root, fs, scopes);
  }
}
