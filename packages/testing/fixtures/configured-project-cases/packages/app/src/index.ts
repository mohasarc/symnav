import { pathTarget } from "@domain/index";
import { workspaceTarget } from "@configured/domain";

export function useConfiguredImports(): string {
  return `${pathTarget()}:${workspaceTarget()}`;
}
