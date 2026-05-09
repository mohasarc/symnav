import type { IgnoreScope } from "./scope.js";
import { pathRelativeToScope } from "./path-relative.js";

export function isIgnoredByScopes(relPath: string, scopes: readonly IgnoreScope[]): boolean {
  for (const scope of scopes) {
    const relToScope = pathRelativeToScope(relPath, scope.dirRelToRoot);
    if (relToScope === null) {
      continue;
    }
    if (scope.matcher.ignores(relToScope)) {
      return true;
    }
  }
  return false;
}
