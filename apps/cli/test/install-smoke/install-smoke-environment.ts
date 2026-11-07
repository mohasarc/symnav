import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class InstallSmokeEnvironment {
  static readonly repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
  );

  static installPrefix(): string {
    return InstallSmokeEnvironment.required("SYMNAV_INSTALL_PREFIX");
  }

  private static required(name: string): string {
    const value = process.env[name];
    if (value === undefined || value === "") {
      throw new Error(`${name} must be set to run the install smoke`);
    }
    return value;
  }
}
