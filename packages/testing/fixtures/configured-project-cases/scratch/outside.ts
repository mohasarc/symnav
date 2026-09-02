import { appLocalTarget } from "@local/local";
import { workspaceTarget } from "@configured/domain";
import { subpathTarget } from "@configured/domain/feature";
import { patternedSubpathTarget } from "@configured/domain/features/patterned";

export function inferredTarget(): string {
  return "inferred";
}

export function useInferredTarget(): string {
  return inferredTarget();
}

export function useConfiguredAliasFromInferred(): string {
  return appLocalTarget();
}

export function useWorkspacePackagesFromInferred(): string {
  return `${workspaceTarget()}:${subpathTarget()}:${patternedSubpathTarget()}`;
}
