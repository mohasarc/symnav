export function isUnderRoot(normalizedAbs: string, root: string): boolean {
  if (normalizedAbs === root) {
    return true;
  }
  const prefix = root === "/" ? "/" : `${root}/`;
  return normalizedAbs.startsWith(prefix);
}
