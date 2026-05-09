import type { IgnoreScope } from "./ignore-scope.js";
import { pathRelativeToScope } from "./path-relative-to-scope.js";

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
