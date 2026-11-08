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

  static expectedVersion(): string {
    return InstallSmokeEnvironment.required("SYMNAV_EXPECTED_VERSION");
  }

  static tarball(): string {
    return InstallSmokeEnvironment.required("SYMNAV_TARBALL");
  }

  static previousTarball(): string | undefined {
    const value = process.env.SYMNAV_PREVIOUS_TARBALL;
    return value === "" ? undefined : value;
  }

  private static required(name: string): string {
    const value = process.env[name];
    if (value === undefined || value === "") {
      throw new Error(`${name} must be set to run the install smoke`);
    }
    return value;
  }
}
