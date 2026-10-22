export interface StateWriteFailure {
  readonly stateDirectory: string;
  readonly operationPath: string;
  readonly osCode?: string;
}

export type InvocationStateAccess =
  | { readonly kind: "unused" }
  | { readonly kind: "available" }
  | { readonly kind: "disabled"; readonly failure: StateWriteFailure };

export interface InvocationStateRequirements {
  readonly daemon: boolean;
  readonly telemetry: boolean;
}
