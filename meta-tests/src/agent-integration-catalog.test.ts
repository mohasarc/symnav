import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const symnavCommands = ["overview", "resolve", "def", "refs", "context", "graph"] as const;
const expectedBundleIds = [
  "full",
  "overview",
  "resolve",
  "def",
  "refs",
  "context",
  "graph",
  "overview-refs",
  "overview-context",
  "overview-def",
  "overview-graph",
  "resolve-graph",
] as const;

type SymnavCommand = (typeof symnavCommands)[number];

interface AgentIntegrationBundleManifest {
  id: (typeof expectedBundleIds)[number];
  skillDirectory: string;
  rulesFile: string;
  allowedCommands: SymnavCommand[];
  claudeSettingsFile: string;
  claudeHookFile: string;
}

interface SymnavAgentIntegrationCatalog {
  schemaVersion: 1;
  sharedRulesFile: string;
  bundles: AgentIntegrationBundleManifest[];
}

class CatalogFixture {
  static readonly repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  private static readonly catalogPath = join(
    CatalogFixture.repositoryRoot,
    ".agents/integrations/symnav/catalog.json",
  );

  static async load(): Promise<SymnavAgentIntegrationCatalog> {
    return JSON.parse(
      await readFile(CatalogFixture.catalogPath, "utf8"),
    ) as SymnavAgentIntegrationCatalog;
  }

  static bundle(
    catalog: SymnavAgentIntegrationCatalog,
    id: AgentIntegrationBundleManifest["id"],
  ): AgentIntegrationBundleManifest {
    const match = catalog.bundles.find((candidate) => candidate.id === id);
    if (!match) {
      throw new Error(`missing bundle: ${id}`);
    }
    return match;
  }

  static async readRepositoryFile(path: string): Promise<string> {
    return readFile(join(CatalogFixture.repositoryRoot, path), "utf8");
  }

  static async validatePaths(catalog: SymnavAgentIntegrationCatalog, root: string): Promise<void> {
    const canonicalRoot = await realpath(root);
    for (const catalogFile of CatalogFixture.bundleFiles(catalog)) {
      const resolvedFile = resolve(root, catalogFile);
      if (CatalogFixture.escapesRoot(relative(root, resolvedFile))) {
        throw new Error(`catalog path escapes repository: ${catalogFile}`);
      }
      const canonicalFile = await realpath(resolvedFile);
      if (CatalogFixture.escapesRoot(relative(canonicalRoot, canonicalFile))) {
        throw new Error(`catalog path escapes repository: ${catalogFile}`);
      }
      if (!(await stat(canonicalFile)).isFile()) {
        throw new Error(`catalog path is not a regular file: ${catalogFile}`);
      }
    }
  }

  static frontmatterName(skill: string): string | undefined {
    return /^name:\s*(.+)$/m.exec(skill)?.[1];
  }

  static namedSymnavCommands(text: string): Set<string> {
    return new Set(
      Array.from(
        text.matchAll(/\bsymnav (overview|resolve|def|refs|context|graph)\b/g),
        (match) => match[1]!,
      ),
    );
  }

  private static bundleFiles(catalog: SymnavAgentIntegrationCatalog): string[] {
    return [
      catalog.sharedRulesFile,
      ...catalog.bundles.flatMap((bundle) => [
        join(bundle.skillDirectory, "SKILL.md"),
        bundle.rulesFile,
        bundle.claudeSettingsFile,
        bundle.claudeHookFile,
      ]),
    ];
  }

  private static escapesRoot(relativePath: string): boolean {
    const separator = process.platform === "win32" ? "\\" : "/";
    return (
      isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${separator}`)
    );
  }
}

describe("symnav agent integration catalog", () => {
  it("loads schema version one from the repository integration directory", async () => {
    const catalog = await CatalogFixture.load();

    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.sharedRulesFile).toBe(".agents/integrations/symnav/shared-rules.md");
    expect(catalog.bundles.length).toBeGreaterThan(0);
  });

  it("declares full, single-command, and paired-command bundles once", async () => {
    const catalog = await CatalogFixture.load();
    const bundleIds = catalog.bundles.map((candidate) => candidate.id);

    expect(bundleIds).toEqual(expectedBundleIds);
    expect(new Set(bundleIds).size).toBe(bundleIds.length);
  });

  it("points full at production skill and all command integration assets", async () => {
    const full = CatalogFixture.bundle(await CatalogFixture.load(), "full");

    expect(full.skillDirectory).toBe(".agents/skills/symnav");
    expect(full.rulesFile).toBe(".agents/integrations/symnav/full/rules.md");
    expect(full.allowedCommands).toEqual(symnavCommands);
    expect(full.claudeSettingsFile).toBe(".agents/integrations/symnav/full/claude-settings.json");
    expect(full.claudeHookFile).toBe(".agents/integrations/symnav/full/symnav-nudge.js");
  });

  it("keeps each variant skill isolated to its allowed commands", async () => {
    const catalog = await CatalogFixture.load();

    for (const variant of catalog.bundles.filter((candidate) => candidate.id !== "full")) {
      const skill = await CatalogFixture.readRepositoryFile(
        join(variant.skillDirectory, "SKILL.md"),
      );

      expect(CatalogFixture.frontmatterName(skill)).toBe(`symnav-${variant.id}`);
      expect(CatalogFixture.namedSymnavCommands(skill)).toEqual(new Set(variant.allowedCommands));
    }
  });

  it("resolves every catalog asset to a regular repository file", async () => {
    await expect(
      CatalogFixture.validatePaths(await CatalogFixture.load(), CatalogFixture.repositoryRoot),
    ).resolves.toBeUndefined();
  });

  it("rejects missing and repository-escaping catalog paths", async () => {
    const catalog = await CatalogFixture.load();

    await expect(
      CatalogFixture.validatePaths(
        { ...catalog, sharedRulesFile: "missing-rules.md" },
        CatalogFixture.repositoryRoot,
      ),
    ).rejects.toThrow();
    await expect(
      CatalogFixture.validatePaths(
        { ...catalog, sharedRulesFile: "../outside-rules.md" },
        CatalogFixture.repositoryRoot,
      ),
    ).rejects.toThrow("catalog path escapes repository");
  });

  it("keeps shared rules neutral and limited to slow-command completion", async () => {
    const sharedRules = await CatalogFixture.readRepositoryFile(
      (await CatalogFixture.load()).sharedRulesFile,
    );

    expect(sharedRules).toContain("wait at least 5 minutes");
    expect(sharedRules).toContain("Continue polling long-running commands");
    expect(sharedRules.toLowerCase()).not.toContain("symnav");
  });

  it("keeps every treatment rules file free of skill-file pointers and task-contract language", async () => {
    const catalog = await CatalogFixture.load();

    for (const treatment of catalog.bundles) {
      const rules = await CatalogFixture.readRepositoryFile(treatment.rulesFile);

      expect(rules).toContain("symnav");
      expect(rules).not.toContain(treatment.skillDirectory);
      expect(rules).not.toContain("Always read");
      expect(rules).not.toMatch(/task requirements?|verification behavior|acceptance criteria/i);
    }
  });

  it("encourages symnav for orienting and confirming without a hard mandate or slow-scare in the full arm", async () => {
    const rules = await CatalogFixture.readRepositoryFile(
      CatalogFixture.bundle(await CatalogFixture.load(), "full").rulesFile,
    );

    expect(rules).toMatch(/orient/i);
    expect(rules).toMatch(/confirm/i);
    expect(rules.toLowerCase()).not.toContain("required");
    expect(rules).not.toMatch(/10 to 20 minutes/);
  });

  it("keeps the diagnostic command variants on the mandate-and-slow-caveat wording", async () => {
    const catalog = await CatalogFixture.load();

    for (const variant of catalog.bundles.filter((candidate) => candidate.id !== "full")) {
      const rules = await CatalogFixture.readRepositoryFile(variant.rulesFile);

      expect(rules.toLowerCase()).toContain("required");
      expect(rules.toLowerCase()).toContain("slow");
    }
  });
});
