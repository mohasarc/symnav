import type { SandboxProbeMessage, SandboxProbeReply } from "./sandbox-probe-message.js";

export interface SandboxProbeChannel {
  ready(signal: AbortSignal): Promise<void>;
  request(message: SandboxProbeMessage, signal?: AbortSignal): Promise<SandboxProbeReply>;
  close(): Promise<void>;
}
