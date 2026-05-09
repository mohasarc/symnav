export function pathRelativeToScope(relPath: string, dirRelToRoot: string): string | null {
  if (dirRelToRoot === "") {
    return relPath;
  }
  const prefix = `${dirRelToRoot}/`;
  if (relPath === dirRelToRoot) {
    return "";
  }
  if (relPath.startsWith(prefix)) {
    return relPath.slice(prefix.length);
  }
  return null;
}
