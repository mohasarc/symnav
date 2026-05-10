export const TYPESCRIPT_EXTENSIONS = [".d.ts", ".ts", ".tsx", ".mts", ".cts"] as const;

export function acceptsTypeScriptFile(filePath: string): boolean {
  const lastSlash = filePath.lastIndexOf("/");
  const basename = (lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1)).toLowerCase();
  for (const ext of TYPESCRIPT_EXTENSIONS) {
    if (basename.endsWith(ext)) {
      return true;
    }
  }
  return false;
}
