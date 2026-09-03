import type { DaemonCommandName } from "@symnav/daemon";

export type InvocationRoute =
  | { readonly kind: "local" }
  | { readonly kind: "daemon-control"; readonly action: "start" | "status" | "stop" }
  | { readonly kind: "workspace"; readonly startDir: string };

export interface SelectedInvocation {
  readonly route: InvocationRoute;
  readonly commandName: DaemonCommandName;
  readonly argv: readonly string[];
}
