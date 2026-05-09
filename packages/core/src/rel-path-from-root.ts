export function relPathFromRoot(dirAbs: string, root: string): string {
  if (dirAbs === root) {
    return "";
  }
  const prefix = root === "/" ? "/" : `${root}/`;
  return dirAbs.startsWith(prefix) ? dirAbs.slice(prefix.length) : "";
}
