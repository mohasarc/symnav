import { domainLocalTarget } from "@local/local";

export function workspaceTarget(): string {
  return "workspace";
}

export function pathTarget(): string {
  return "path";
}

export function useDomainLocal(): string {
  return domainLocalTarget();
}
