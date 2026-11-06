import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export class AgentConfigurationFile {
  public constructor(private readonly configurationPath: string) {}

  public async read(): Promise<string> {
    try {
      const metadata = await lstat(this.configurationPath);
      if (!metadata.isFile()) throw new Error("configuration must be a regular file");
      return await readFile(this.configurationPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  public async publish(original: string, updated: string): Promise<void> {
    let mode = 0o600;
    try {
      mode = (await lstat(this.configurationPath)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const directory = dirname(this.configurationPath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = join(directory, `.symnav-${randomUUID()}.tmp`);
    try {
      const temporary = await open(temporaryPath, "wx", 0o600);
      try {
        await temporary.writeFile(updated, "utf8");
        await temporary.chmod(mode);
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      if ((await this.read()) !== original)
        throw new Error("configuration changed during setup; retry");
      await rename(temporaryPath, this.configurationPath);
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}
