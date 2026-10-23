import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";

export class AgentExecutable {
  public static async installed(name: string): Promise<boolean> {
    const extensions =
      process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
    for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      for (const extension of extensions) {
        const path = join(directory, `${name}${extension}`);
        try {
          if (!(await stat(path)).isFile()) continue;
          await access(path, constants.X_OK);
          return true;
        } catch {
          continue;
        }
      }
    }
    return false;
  }
}
