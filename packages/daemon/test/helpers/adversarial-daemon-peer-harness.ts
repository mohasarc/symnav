import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient, DaemonPolicy, type RunningDaemonStatus } from "@symnav/daemon";
import { DaemonWorkspaceIdentity } from "../../src/registry/workspace-identity.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRecord,
} from "../../src/transport/protocol.js";
import { createDaemonExecutor } from "../fixtures/executor-module.js";
import { CanonicalTestPath } from "./canonical-path.js";
import { TestDaemonRegistry as DaemonRegistry } from "./daemon-registry.js";

export class AdversarialDaemonPeerHarness {
  readonly workspaceRoot: string;
  readonly #stateDirectory: string;
  readonly #identity: DaemonWorkspaceIdentity;
  readonly #registry: DaemonRegistry;
  readonly #client: DaemonClient;
  readonly #actors: ActorProcess[] = [];

  private constructor() {
    this.#stateDirectory = CanonicalTestPath.resolve(
      mkdtempSync(join(tmpdir(), "symnav-adversarial-peer-state-")),
    );
    this.workspaceRoot = CanonicalTestPath.resolve(
      mkdtempSync(join(tmpdir(), "symnav-adversarial-peer-workspace-")),
    );
    mkdirSync(join(this.workspaceRoot, ".git"));
    writeFileSync(join(this.workspaceRoot, "input.ts"), "export const value = 1;\n");
    this.#identity = DaemonWorkspaceIdentity.from(this.workspaceRoot, this.#stateDirectory);
    this.#registry = new DaemonRegistry(this.#identity.registryDirectory);
    this.#client = new DaemonClient({
      stateDirectory: this.#stateDirectory,
      productVersion: "0.1.0",
      daemonEnabled: true,
      executorFactory: createDaemonExecutor,
      executorModuleUrl: new URL("../fixtures/executor-module.mjs", import.meta.url).href,
      readinessProbe: { commandName: "version", argv: ["--version"] },
      policy: DaemonPolicy.currentSystem(),
    });
  }

  static create(): AdversarialDaemonPeerHarness {
    return new AdversarialDaemonPeerHarness();
  }

  async startStartupPublisher(): Promise<StartupPublisherPeer> {
    const readyPath = join(this.#stateDirectory, "publisher-ready");
    const barrierPath = join(this.#stateDirectory, "publisher-go");
    const resultPath = join(this.#stateDirectory, "publisher-result");
    const actor = this.spawnActor("daemon-startup-publisher.ts", [
      this.workspaceRoot,
      this.#stateDirectory,
      readyPath,
      barrierPath,
      resultPath,
    ]);
    await actor.waitForFile(readyPath);
    return new StartupPublisherPeer(actor, barrierPath, resultPath);
  }

  async startLiveSilentPeer(): Promise<AuthenticatedPeer> {
    return this.startAuthenticatedPeer("daemon-live-silent.ts", "live-silent", []);
  }

  async startMalformedActivityPeer(secret: string): Promise<AuthenticatedPeer> {
    return this.startAuthenticatedPeer("daemon-malformed-activity.ts", "malformed-activity", [
      secret,
    ]);
  }

  status(): Promise<readonly RunningDaemonStatus[]> {
    return this.#client.control({ action: "status" });
  }

  record(): DaemonRecord | undefined {
    return this.#registry.read(this.#identity);
  }

  async dispose(): Promise<void> {
    await Promise.all(this.#actors.map((actor) => actor.terminate()));
    rmSync(this.#stateDirectory, { recursive: true, force: true });
    rmSync(this.workspaceRoot, { recursive: true, force: true });
  }

  private async startAuthenticatedPeer(
    filename: string,
    instanceId: string,
    trailingArguments: readonly string[],
  ): Promise<AuthenticatedPeer> {
    const processToken = `${instanceId}-process`;
    const startedAt = Date.now();
    const readyPath = join(this.#stateDirectory, `${instanceId}-ready`);
    const actor = this.spawnActor(filename, [
      this.#identity.endpoint(instanceId),
      instanceId,
      processToken,
      String(startedAt),
      readyPath,
      ...trailingArguments,
    ]);
    await actor.waitForFile(readyPath);
    const pid = Number(readFileSync(readyPath, "utf8"));
    this.#registry.write(this.readyRecord({ instanceId, processToken, startedAt, pid }));
    return new AuthenticatedPeer(instanceId, processToken, pid);
  }

  private readyRecord(peer: {
    readonly instanceId: string;
    readonly processToken: string;
    readonly startedAt: number;
    readonly pid: number;
  }): DaemonRecord {
    return {
      schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      symnavVersion: "0.1.0",
      workspaceRoot: this.workspaceRoot,
      workspaceKey: this.#identity.workspaceKey,
      stateKey: this.#identity.stateKey,
      identityKey: this.#identity.identityKey,
      instanceId: peer.instanceId,
      processToken: peer.processToken,
      endpoint: this.#identity.endpoint(peer.instanceId),
      pid: peer.pid,
      state: "ready",
      startedAt: peer.startedAt,
      readyAt: peer.startedAt,
      fileCount: 1,
      memoryCapBytes: Number.MAX_SAFE_INTEGER,
    };
  }

  private spawnActor(filename: string, arguments_: readonly string[]): ActorProcess {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
        fileURLToPath(new URL(`../actors/${filename}`, import.meta.url)),
        ...arguments_,
      ],
      { stdio: "ignore" },
    );
    const actor = new ActorProcess(child);
    this.#actors.push(actor);
    return actor;
  }
}

class StartupPublisherPeer {
  constructor(
    private readonly actor: ActorProcess,
    private readonly barrierPath: string,
    private readonly resultPath: string,
  ) {}

  async publishAndExit(): Promise<{
    readonly startingPublished: boolean;
    readonly readyPublished: boolean;
  }> {
    writeFileSync(this.barrierPath, "go");
    await this.actor.waitForSuccessfulExit();
    return JSON.parse(readFileSync(this.resultPath, "utf8")) as {
      readonly startingPublished: boolean;
      readonly readyPublished: boolean;
    };
  }
}

class AuthenticatedPeer {
  constructor(
    readonly instanceId: string,
    readonly processToken: string,
    readonly pid: number,
  ) {}
}

class ActorProcess {
  constructor(private readonly child: ChildProcess) {}

  async waitForFile(path: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() <= deadline) {
      if (existsSync(path)) return;
      this.assertRunning();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for actor file: ${path}`);
  }

  waitForSuccessfulExit(): Promise<void> {
    if (this.child.exitCode !== null) {
      return this.child.exitCode === 0
        ? Promise.resolve()
        : Promise.reject(new Error(`Actor exited with code ${String(this.child.exitCode)}`));
    }
    if (this.child.signalCode !== null) {
      return Promise.reject(new Error(`Actor exited with signal ${this.child.signalCode}`));
    }
    return new Promise((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else if (signal !== null) reject(new Error(`Actor exited with signal ${signal}`));
        else reject(new Error(`Actor exited with code ${String(code)}`));
      });
    });
  }

  async terminate(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.kill("SIGTERM");
    await exited;
  }

  private assertRunning(): void {
    if (this.child.exitCode !== null) {
      throw new Error(`Actor exited with code ${String(this.child.exitCode)}`);
    }
    if (this.child.signalCode !== null) {
      throw new Error(`Actor exited with signal ${this.child.signalCode}`);
    }
  }
}
