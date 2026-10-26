import { DaemonProcessLifetimeCreationError } from "./process-lifetime-creation-error.js";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  DaemonProcessLifetimeIdentity,
  DaemonProcessLifetimeObservation,
} from "./process-lifetime-identity.js";

export class PosixDaemonChildLifetime {
  private closed = false;
  public constructor(
    public readonly identity: DaemonProcessLifetimeIdentity,
    public readonly descriptor: number,
  ) {}
  public closeParentCopy(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.descriptor);
  }
}

export class PosixDaemonProcessLifetime {
  private static readonly authorities = new Map<
    string,
    { readonly identity: DaemonProcessLifetimeIdentity; readonly descriptor: number }
  >();

  public static current(stateDirectory: string): DaemonProcessLifetimeIdentity {
    const state = resolve(stateDirectory);
    const existing = this.authorities.get(state);
    if (existing !== undefined) return existing.identity;
    const prepared = this.prepareChild(state);
    this.authorities.set(state, { identity: prepared.identity, descriptor: prepared.descriptor });
    return prepared.identity;
  }

  public static prepareChild(stateDirectory: string): PosixDaemonChildLifetime {
    try {
      return this.createChild(stateDirectory);
    } catch (error) {
      throw new DaemonProcessLifetimeCreationError(error);
    }
  }

  private static createChild(stateDirectory: string): PosixDaemonChildLifetime {
    if (process.platform === "win32")
      throw new Error("POSIX process lifetime is unavailable on Windows");
    const directory = join(resolve(stateDirectory), "process-lifetimes");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory())
      throw new Error("Invalid daemon process lifetime directory");
    const token = randomUUID();
    const identity: DaemonProcessLifetimeIdentity = {
      token,
      path: join(directory, `${token}.fifo`),
    };
    const creation = spawnSync("mkfifo", ["-m", "600", identity.path], { stdio: "ignore" });
    if (creation.error !== undefined) throw creation.error;
    if (creation.status !== 0)
      throw new Error(
        `Daemon process lifetime creation failed (${creation.status ?? creation.signal})`,
      );
    const descriptor = openSync(
      identity.path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    if (!fstatSync(descriptor).isFIFO()) {
      closeSync(descriptor);
      throw new Error("Invalid daemon process lifetime descriptor");
    }
    return new PosixDaemonChildLifetime(identity, descriptor);
  }

  public static adoptChild(
    stateDirectory: string,
    identity: DaemonProcessLifetimeIdentity,
    descriptor: number,
  ): void {
    if (!this.isIdentity(identity, stateDirectory) || descriptor !== 3)
      throw new Error("Invalid inherited daemon process lifetime");
    const metadata = fstatSync(descriptor);
    const stored = lstatSync(identity.path);
    if (
      !metadata.isFIFO() ||
      !stored.isFIFO() ||
      metadata.dev !== stored.dev ||
      metadata.ino !== stored.ino
    )
      throw new Error("Invalid inherited daemon process lifetime descriptor");
    this.authorities.set(resolve(stateDirectory), { identity, descriptor });
  }

  public static isIdentity(
    value: unknown,
    stateDirectory?: string,
  ): value is DaemonProcessLifetimeIdentity {
    if (typeof value !== "object" || value === null) return false;
    const identity = value as Record<string, unknown>;
    if (
      typeof identity.token !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(identity.token) ||
      typeof identity.path !== "string" ||
      identity.path.length > 4096 ||
      !isAbsolute(identity.path)
    )
      return false;
    return (
      basename(identity.path) === `${identity.token}.fifo` &&
      basename(dirname(identity.path)) === "process-lifetimes" &&
      (stateDirectory === undefined ||
        dirname(identity.path) === join(resolve(stateDirectory), "process-lifetimes"))
    );
  }

  public static observe(identity: DaemonProcessLifetimeIdentity): DaemonProcessLifetimeObservation {
    if (!this.isIdentity(identity) || process.platform === "win32") return "unknown";
    try {
      const before = lstatSync(identity.path);
      if (!before.isFIFO() || !lstatSync(dirname(identity.path)).isDirectory()) return "unknown";
      try {
        const descriptor = openSync(
          identity.path,
          constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
        );
        try {
          const opened = fstatSync(descriptor);
          return opened.isFIFO() && opened.dev === before.dev && opened.ino === before.ino
            ? "live"
            : "unknown";
        } finally {
          closeSync(descriptor);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENXIO") return "unknown";
        const after = lstatSync(identity.path);
        return after.isFIFO() && before.dev === after.dev && before.ino === after.ino
          ? "exited"
          : "unknown";
      }
    } catch {
      return "unknown";
    }
  }
}
