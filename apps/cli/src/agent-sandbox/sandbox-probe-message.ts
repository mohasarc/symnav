import type { DaemonStatusReport } from "@symnav/daemon";

export type SandboxProbeMessage = { readonly action: "run" | "status" | "cleanup" };
export type SandboxProbeReply =
  | { readonly kind: "ready" }
  | {
      readonly kind: "command";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: "status"; readonly report: DaemonStatusReport }
  | { readonly kind: "cleaned"; readonly failure?: string }
  | { readonly kind: "error"; readonly message: string };
