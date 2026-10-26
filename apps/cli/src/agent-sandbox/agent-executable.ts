import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, resolve } from "node:path";

export class AgentExecutable {
  public static async installed(name: string): Promise<boolean> {
    return (await this.find(name)) !== undefined;
  }

  public static async find(name: string): Promise<string | undefined> {
    const extensions =
      process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
    for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      for (const extension of extensions) {
        const path = resolve(directory, `${name}${extension}`);
        try {
          if (!(await stat(path)).isFile()) continue;
          await access(path, constants.X_OK);
          return path;
        } catch {
          continue;
        }
      }
    }
    return undefined;
  }
}
