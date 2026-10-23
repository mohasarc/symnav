import type { SupportedAgent } from "./agent-configuration.js";

export type AgentDoctorResult =
  | { readonly agent: SupportedAgent; readonly status: "ok"; readonly check: "live" }
  | {
      readonly agent: SupportedAgent;
      readonly status: "ok";
      readonly check: "configuration";
      readonly skippedReason: string;
    }
  | { readonly agent: SupportedAgent; readonly status: "fail"; readonly reason: string }
  | { readonly agent: SupportedAgent; readonly status: "skip"; readonly reason: string };
