export function computeDirSet(fileSet: Set<string>): Set<string> {
  const dirs = new Set<string>();
  for (const filePath of fileSet) {
    const segments = filePath.split("/");
    let current = segments[0] ?? "";
    for (let i = 1; i < segments.length - 1; i++) {
      current = current === "" ? `/${segments[i]}` : `${current}/${segments[i]}`;
      dirs.add(current);
    }
    if (filePath.startsWith("/") && segments.length > 1) {
      dirs.add("/");
    }
  }
  return dirs;
}
