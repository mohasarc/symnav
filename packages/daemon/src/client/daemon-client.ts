import type {
  DaemonStartResult,
  DaemonStopResult,
  RunningDaemonStatus,
} from "../daemon-lifecycle-report.js";
import type {
  DaemonClientExecuteRequest,
  DaemonClientExecuteResult,
  DaemonClientOptions,
  DaemonControlRequest,
} from "./daemon-client-contracts.js";

interface DaemonClientRuntimePort {
  execute(request: DaemonClientExecuteRequest): Promise<DaemonClientExecuteResult>;
  control(
    request: DaemonControlRequest,
  ): Promise<DaemonStartResult | readonly RunningDaemonStatus[] | DaemonStopResult>;
}

class DaemonClientRuntimeLoader {
  static async load(options: DaemonClientOptions): Promise<DaemonClientRuntimePort> {
    const runtimeModuleUrl: string = "./daemon-client-runtime.js";
    const loaded: unknown = await import(runtimeModuleUrl);
    if (
      typeof loaded !== "object" ||
      loaded === null ||
      !("DaemonClientRuntime" in loaded) ||
      typeof loaded.DaemonClientRuntime !== "function"
    ) {
      throw new Error("Daemon client runtime is unavailable");
    }
    const Runtime = loaded.DaemonClientRuntime as new (
      options: DaemonClientOptions,
    ) => DaemonClientRuntimePort;
    return new Runtime(options);
  }
}

export class DaemonClient {
  private readonly runtime: Promise<DaemonClientRuntimePort>;

  constructor(options: DaemonClientOptions) {
    this.runtime = DaemonClientRuntimeLoader.load(options);
  }

  async execute(request: DaemonClientExecuteRequest): Promise<DaemonClientExecuteResult> {
    return (await this.runtime).execute(request);
  }

  control(
    request: Extract<DaemonControlRequest, { readonly action: "start" }>,
  ): Promise<DaemonStartResult>;
  control(
    request: Extract<DaemonControlRequest, { readonly action: "status" }>,
  ): Promise<readonly RunningDaemonStatus[]>;
  control(
    request: Extract<DaemonControlRequest, { readonly action: "stop" }>,
  ): Promise<DaemonStopResult>;
  async control(
    request: DaemonControlRequest,
  ): Promise<DaemonStartResult | readonly RunningDaemonStatus[] | DaemonStopResult> {
    return (await this.runtime).control(request);
  }
}
