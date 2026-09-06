import type { DaemonCommandName } from "@symnav/daemon";

export type InvocationRoute =
  | { readonly kind: "local"; readonly commandName: DaemonCommandName }
  | { readonly kind: "control"; readonly action: "start" | "status" | "stop" }
  | {
      readonly kind: "workspace";
      readonly commandName: DaemonCommandName;
      readonly startDirectory: string;
    };

export interface SelectedInvocation {
  readonly route: InvocationRoute;
  readonly argv: readonly string[];
}
