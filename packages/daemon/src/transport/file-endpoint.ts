import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PosixDaemonProcessLifetime } from "../process/posix-process-lifetime.js";
import type { FileDaemonEndpointOwner, FileDaemonOwner } from "./file-owner.js";

export class FileDaemonEndpoint {
  public static async owner(endpoint: string): Promise<FileDaemonEndpointOwner> {
    const entries = await readdir(endpoint, { withFileTypes: true });
    const tokens = entries.filter(
      (entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name),
    );
    if (tokens.length !== 1) throw new Error("Invalid daemon file endpoint owner");
    const directory = join(endpoint, tokens[0]!.name);
    const owner = await this.readOwner(directory);
    if (owner.token !== tokens[0]!.name)
      throw new Error("Invalid daemon file endpoint ownership token");
    return { ...owner, directory };
  }

  public static async readOwner(directory: string): Promise<FileDaemonOwner> {
    const file = await open(
      join(directory, "owner.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > 8192)
        throw new Error("Invalid daemon file endpoint owner");
      const value: unknown = JSON.parse(await file.readFile("utf8"));
      if (typeof value !== "object" || value === null)
        throw new Error("Invalid daemon file endpoint owner");
      const owner = value as Record<string, unknown>;
      if (
        typeof owner.token !== "string" ||
        !/^[a-f0-9-]{36}$/.test(owner.token) ||
        !Number.isSafeInteger(owner.pid) ||
        (owner.pid as number) <= 0 ||
        !PosixDaemonProcessLifetime.isIdentity(owner.processLifetime)
      )
        throw new Error("Invalid daemon file endpoint owner");
      return {
        token: owner.token,
        pid: owner.pid as number,
        processLifetime: owner.processLifetime,
      };
    } finally {
      await file.close();
    }
  }

  public static sameOwner(left: FileDaemonOwner, right: FileDaemonOwner): boolean {
    return (
      left.token === right.token &&
      left.processLifetime.token === right.processLifetime.token &&
      left.processLifetime.path === right.processLifetime.path
    );
  }
}
