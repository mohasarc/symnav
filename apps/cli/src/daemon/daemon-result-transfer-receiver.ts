import type { DaemonExecutorExecutionResult } from "@symnav/daemon";
import type { CompletionSpoolManifest } from "./completion-spool.js";
import type { DaemonExecutionServerFrame, DaemonResultChunk } from "./daemon-protocol.js";
import type {
  DaemonCapturedOutputSummary,
  DaemonOutputCapture,
} from "./daemon-client-result-capture.js";

type ResultManifestFrame = Extract<
  DaemonExecutionServerFrame,
  { readonly kind: "result-manifest" }
>;

type ResultEndFrame = Extract<DaemonExecutionServerFrame, { readonly kind: "result-end" }>;

export class DaemonResultTransferReceiver {
  private expectedManifest: CompletionSpoolManifest | undefined;
  private nextRecordOffset = 0;
  private manifestReceived = false;
  private terminalReceived = false;
  private completed = false;
  private disposal: Promise<void> | undefined;

  constructor(
    private readonly requestId: string,
    private readonly output: DaemonOutputCapture,
  ) {}

  get manifest(): CompletionSpoolManifest | undefined {
    return this.expectedManifest;
  }

  get nextOffset(): number {
    return this.nextRecordOffset;
  }

  get terminal(): boolean {
    return this.terminalReceived;
  }

  beginConnection(): void {
    this.manifestReceived = false;
    this.terminalReceived = false;
  }

  acceptManifest(frame: ResultManifestFrame): void {
    if (this.manifestReceived || this.terminalReceived) {
      throw new Error("Duplicate result manifest");
    }
    if (
      this.expectedManifest !== undefined &&
      !DaemonResultTransferReceiver.manifestsMatch(this.expectedManifest, frame.manifest)
    ) {
      throw new Error("Daemon resumed with a different result manifest");
    }
    if (
      frame.requestId !== this.requestId ||
      frame.manifest.requestId !== this.requestId ||
      frame.manifest.instanceId !== frame.instanceId
    ) {
      throw new Error("Daemon result manifest has invalid coordinates");
    }
    this.expectedManifest ??= frame.manifest;
    this.manifestReceived = true;
  }

  async acceptChunk(chunk: DaemonResultChunk): Promise<void> {
    const manifest = this.expectedManifest;
    if (
      !this.manifestReceived ||
      this.terminalReceived ||
      manifest === undefined ||
      chunk.requestId !== this.requestId ||
      chunk.transferId !== manifest.transferId ||
      chunk.offset !== this.nextRecordOffset ||
      chunk.sequence !== this.nextRecordOffset
    ) {
      throw new Error("Daemon returned an invalid result chunk");
    }
    await this.output.append({
      sequence: chunk.sequence,
      stream: chunk.stream,
      bytes: chunk.bytes,
    });
    this.nextRecordOffset += 1;
  }

  acceptEnd(frame: ResultEndFrame): void {
    const manifest = this.expectedManifest;
    if (
      !this.manifestReceived ||
      this.terminalReceived ||
      manifest === undefined ||
      frame.instanceId !== manifest.instanceId ||
      frame.requestId !== this.requestId ||
      frame.transferId !== manifest.transferId ||
      frame.rawBytes !== manifest.rawBytes ||
      frame.recordCount !== manifest.recordCount ||
      frame.sha256 !== manifest.sha256 ||
      this.nextRecordOffset !== manifest.recordCount
    ) {
      throw new Error("Daemon result transfer did not match its manifest");
    }
    this.terminalReceived = true;
  }

  async finish(): Promise<DaemonExecutorExecutionResult> {
    const manifest = this.expectedManifest;
    if (!this.terminalReceived || manifest === undefined) {
      throw new Error("Daemon result transfer is incomplete");
    }
    try {
      const captured = await this.output.finish(manifest.exitCode);
      if (!DaemonResultTransferReceiver.summariesMatch(captured.summary, manifest)) {
        this.disposal = captured.result.output.dispose();
        await this.disposal;
        throw new Error("Daemon result transfer failed digest validation");
      }
      this.completed = true;
      return captured.result;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  dispose(): Promise<void> {
    if (this.completed) return Promise.resolve();
    this.disposal ??= this.output.dispose();
    return this.disposal;
  }

  private static manifestsMatch(
    expected: CompletionSpoolManifest,
    actual: CompletionSpoolManifest,
  ): boolean {
    return (
      actual.transferId === expected.transferId &&
      actual.requestId === expected.requestId &&
      actual.instanceId === expected.instanceId &&
      actual.exitCode === expected.exitCode &&
      DaemonResultTransferReceiver.summariesMatch(actual, expected)
    );
  }

  private static summariesMatch(
    actual: CompletionSpoolManifest | DaemonCapturedOutputSummary,
    expected: CompletionSpoolManifest,
  ): boolean {
    return (
      actual.rawBytes === expected.rawBytes &&
      actual.recordCount === expected.recordCount &&
      actual.sha256 === expected.sha256
    );
  }
}
