import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

export class FileDaemonEndpoint {
  public static async ownerPid(endpoint: string): Promise<number> {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const file = await open(join(endpoint, "owner.json"), constants.O_RDONLY | noFollow);
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > 1024)
        throw new Error("Invalid daemon file endpoint owner");
      const value: unknown = JSON.parse(await file.readFile("utf8"));
      if (
        typeof value !== "object" ||
        value === null ||
        !("pid" in value) ||
        !Number.isSafeInteger(value.pid) ||
        (value.pid as number) <= 0
      )
        throw new Error("Invalid daemon file endpoint owner");
      return value.pid as number;
    } finally {
      await file.close();
    }
  }

  public static isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }
}
