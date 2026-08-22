export function canonicalWorkspaceRoot(workspaceRoot: string): string {
  return workspaceRoot.replaceAll("\\", "/");
}
