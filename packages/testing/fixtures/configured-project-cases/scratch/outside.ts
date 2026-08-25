import { appLocalTarget } from "@local/local";

export function inferredTarget(): string {
  return "inferred";
}

export function useInferredTarget(): string {
  return inferredTarget();
}

export function useConfiguredAliasFromInferred(): string {
  return appLocalTarget();
}
