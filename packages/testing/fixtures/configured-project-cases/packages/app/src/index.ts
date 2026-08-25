import { pathTarget } from "@domain/index";
import { workspaceTarget } from "@configured/domain";
import { inheritedTarget } from "@inherited/inherited";
import { appLocalTarget } from "@local/local";

export function useConfiguredImports(): string {
  return `${pathTarget()}:${workspaceTarget()}`;
}

export function useAppLocal(): string {
  return appLocalTarget();
}

export function useInheritedConfiguration(): string {
  return inheritedTarget();
}
