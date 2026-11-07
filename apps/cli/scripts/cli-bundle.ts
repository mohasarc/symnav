import { build, type Metafile, type Plugin } from "esbuild";

export interface CliBundleEntry {
  readonly outName: string;
  readonly source: string;
}

export interface CliBundleOptions {
  readonly outDirectory: string;
  readonly packageRoot: string;
}

export interface CliBundleResult {
  readonly externalImports: ReadonlySet<string>;
}

export class CliBundle {
  static readonly ENTRIES: readonly CliBundleEntry[] = [
    { outName: "cli", source: "./src/cli.ts" },
    { outName: "daemon-executor", source: "./src/daemon-executor.ts" },
    { outName: "sandbox-probe-entry", source: "./src/agent-sandbox/sandbox-probe-entry.ts" },
    { outName: "process-entry", source: "@symnav/daemon/process-entry" },
    { outName: "worker-entry", source: "@symnav/daemon/worker-entry" },
  ];

  private static readonly INLINED_SCOPE = "@symnav/";
  private static readonly NODE_TARGET = "node20";

  constructor(private readonly options: CliBundleOptions) {}

  async build(): Promise<CliBundleResult> {
    const result = await build({
      absWorkingDir: this.options.packageRoot,
      entryPoints: CliBundle.ENTRIES.map((entry) => ({ in: entry.source, out: entry.outName })),
      outdir: this.options.outDirectory,
      bundle: true,
      format: "esm",
      platform: "node",
      target: CliBundle.NODE_TARGET,
      metafile: true,
      logLevel: "warning",
      plugins: [CliBundle.thirdPartyExternals()],
    });
    return { externalImports: CliBundle.externalImportsOf(result.metafile) };
  }

  private static thirdPartyExternals(): Plugin {
    return {
      name: "third-party-externals",
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^[^./]/ }, (args) => {
          const isPackageImport = args.kind !== "entry-point" && !CliBundle.isPath(args.path);
          if (!isPackageImport || args.path.startsWith(CliBundle.INLINED_SCOPE)) return undefined;
          return { path: args.path, external: true };
        });
      },
    };
  }

  private static isPath(specifier: string): boolean {
    return /^(?:[A-Za-z]:[\\/]|\/)/.test(specifier);
  }

  private static externalImportsOf(metafile: Metafile): ReadonlySet<string> {
    const imports = Object.values(metafile.outputs).flatMap((output) => output.imports);
    return new Set(imports.filter((entry) => entry.external).map((entry) => entry.path));
  }
}
