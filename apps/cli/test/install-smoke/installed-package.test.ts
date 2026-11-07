import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { E2eProcessCleanup } from "../helpers/e2e-process-cleanup.js";
import { InstallSmokeEnvironment } from "./install-smoke-environment.js";
import { InstalledSymnav } from "./installed-symnav.js";

interface InstalledManifest {
  readonly private?: boolean;
  readonly dependencies?: Readonly<Record<string, string>>;
}

class InstalledPackage {
  private static readonly BARE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*)"([^".][^"]*)"/g;

  constructor(private readonly directory: string) {}

  manifest(): InstalledManifest {
    return JSON.parse(
      readFileSync(join(this.directory, "package.json"), "utf8"),
    ) as InstalledManifest;
  }

  bundledPackageImports(): readonly string[] {
    const distDirectory = join(this.directory, "dist");
    const packages = new Set<string>();
    for (const file of readdirSync(distDirectory).filter((name) => name.endsWith(".js"))) {
      const source = readFileSync(join(distDirectory, file), "utf8");
      for (const match of source.matchAll(InstalledPackage.BARE_IMPORT)) {
        const specifier = match[1]!;
        if (!InstalledPackage.isBuiltin(specifier)) packages.add(InstalledPackage.name(specifier));
      }
    }
    return [...packages].sort();
  }

  private static isBuiltin(specifier: string): boolean {
    return specifier.startsWith("node:") || builtinModules.includes(specifier);
  }

  private static name(specifier: string): string {
    const segments = specifier.split("/");
    const isScoped = specifier.startsWith("@");
    return segments.slice(0, isScoped ? 2 : 1).join("/");
  }
}

describe("installed symnav package", () => {
  const runRoot = mkdtempSync(join(tmpdir(), "symnav-install-smoke-"));
  const symnav = new InstalledSymnav({
    prefix: InstallSmokeEnvironment.installPrefix(),
    stateDirectory: join(runRoot, "state"),
    workspaceDirectory: InstallSmokeEnvironment.repositoryRoot,
    daemon: "cold",
  });
  const installedPackage = new InstalledPackage(symnav.packageDirectory);

  afterAll(() => E2eProcessCleanup.removeDirectories([runRoot]));

  it("is installed outside the repository", () => {
    const repositoryRoot = realpathSync(InstallSmokeEnvironment.repositoryRoot);
    const packageDirectory = realpathSync(symnav.packageDirectory);

    const pathFromRepository = relative(repositoryRoot, packageDirectory);
    const isOutsideRepository =
      pathFromRepository.startsWith("..") || isAbsolute(pathFromRepository);

    expect(isOutsideRepository).toBe(true);
  });

  it("is not private", () => {
    expect(installedPackage.manifest()).not.toHaveProperty("private");
  });

  it("ships the bundled cli and license", () => {
    expect(existsSync(join(symnav.packageDirectory, "dist", "cli.js"))).toBe(true);
    expect(existsSync(join(symnav.packageDirectory, "LICENSE"))).toBe(true);
  });

  it("installs every package the bundle imports as its own dependency", () => {
    const dependencies = Object.keys(installedPackage.manifest().dependencies ?? {});

    for (const packageName of installedPackage.bundledPackageImports()) {
      expect(dependencies).toContain(packageName);
      expect(existsSync(join(symnav.packageDirectory, "node_modules", packageName))).toBe(true);
    }
  });
});
