import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const catalogPath = join(repositoryRoot, ".agents/integrations/symnav/catalog.json");
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

async function loadCatalog(): Promise<SymnavAgentIntegrationCatalog> {
  return JSON.parse(await readFile(catalogPath, "utf8")) as SymnavAgentIntegrationCatalog;
}

function bundleFiles(catalog: SymnavAgentIntegrationCatalog): string[] {
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

async function validateCatalogPaths(
  catalog: SymnavAgentIntegrationCatalog,
  root: string,
): Promise<void> {
  const canonicalRoot = await realpath(root);
  for (const catalogFile of bundleFiles(catalog)) {
    const resolvedFile = resolve(root, catalogFile);
    const relativeFile = relative(root, resolvedFile);
    if (
      isAbsolute(relativeFile) ||
      relativeFile === ".." ||
      relativeFile.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    ) {
      throw new Error(`catalog path escapes repository: ${catalogFile}`);
    }
    const canonicalFile = await realpath(resolvedFile);
    const canonicalRelativeFile = relative(canonicalRoot, canonicalFile);
    if (
      isAbsolute(canonicalRelativeFile) ||
      canonicalRelativeFile === ".." ||
      canonicalRelativeFile.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    ) {
      throw new Error(`catalog path escapes repository: ${catalogFile}`);
    }
    if (!(await stat(canonicalFile)).isFile()) {
      throw new Error(`catalog path is not a regular file: ${catalogFile}`);
    }
  }
}

function bundle(
  catalog: SymnavAgentIntegrationCatalog,
  id: AgentIntegrationBundleManifest["id"],
): AgentIntegrationBundleManifest {
  const match = catalog.bundles.find((candidate) => candidate.id === id);
  if (!match) {
    throw new Error(`missing bundle: ${id}`);
  }
  return match;
}

async function readRepositoryFile(path: string): Promise<string> {
  return readFile(join(repositoryRoot, path), "utf8");
}

function frontmatterName(skill: string): string | undefined {
  return /^name:\s*(.+)$/m.exec(skill)?.[1];
}

function namedSymnavCommands(text: string): Set<string> {
  return new Set(
    Array.from(
      text.matchAll(/\bsymnav (overview|resolve|def|refs|context|graph)\b/g),
      (match) => match[1]!,
    ),
  );
}

describe("symnav agent integration catalog", () => {
  it("loads schema version one from the repository integration directory", async () => {
    const catalog = await loadCatalog();

    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.sharedRulesFile).toBe(".agents/integrations/symnav/shared-rules.md");
    expect(catalog.bundles.length).toBeGreaterThan(0);
  });

  it("declares full, single-command, and paired-command bundles once", async () => {
    const catalog = await loadCatalog();
    const bundleIds = catalog.bundles.map((candidate) => candidate.id);

    expect(bundleIds).toEqual(expectedBundleIds);
    expect(new Set(bundleIds).size).toBe(bundleIds.length);
  });

  it("points full at production skill and all command integration assets", async () => {
    const full = bundle(await loadCatalog(), "full");

    expect(full.skillDirectory).toBe(".agents/skills/symnav");
    expect(full.rulesFile).toBe(".agents/integrations/symnav/full/rules.md");
    expect(full.allowedCommands).toEqual(symnavCommands);
    expect(full.claudeSettingsFile).toBe(".agents/integrations/symnav/full/claude-settings.json");
    expect(full.claudeHookFile).toBe(".agents/integrations/symnav/full/symnav-nudge.js");
  });

  it("keeps each variant skill isolated to its allowed commands", async () => {
    const catalog = await loadCatalog();

    for (const variant of catalog.bundles.filter((candidate) => candidate.id !== "full")) {
      const skill = await readRepositoryFile(join(variant.skillDirectory, "SKILL.md"));

      expect(frontmatterName(skill)).toBe(`symnav-${variant.id}`);
      expect(namedSymnavCommands(skill)).toEqual(new Set(variant.allowedCommands));
    }
  });

  it("resolves every catalog asset to a regular repository file", async () => {
    await expect(
      validateCatalogPaths(await loadCatalog(), repositoryRoot),
    ).resolves.toBeUndefined();
  });

  it("rejects missing and repository-escaping catalog paths", async () => {
    const catalog = await loadCatalog();

    await expect(
      validateCatalogPaths({ ...catalog, sharedRulesFile: "missing-rules.md" }, repositoryRoot),
    ).rejects.toThrow();
    await expect(
      validateCatalogPaths({ ...catalog, sharedRulesFile: "../outside-rules.md" }, repositoryRoot),
    ).rejects.toThrow("catalog path escapes repository");
  });

  it("keeps shared rules neutral and limited to slow-command completion", async () => {
    const sharedRules = await readRepositoryFile((await loadCatalog()).sharedRulesFile);

    expect(sharedRules).toContain("wait at least 5 minutes");
    expect(sharedRules).toContain("Continue polling long-running commands");
    expect(sharedRules.toLowerCase()).not.toContain("symnav");
  });

  it("requires each treatment to read its selected skill without changing the task contract", async () => {
    const catalog = await loadCatalog();

    for (const treatment of catalog.bundles) {
      const rules = await readRepositoryFile(treatment.rulesFile);

      expect(rules).toContain(treatment.skillDirectory);
      expect(rules).toContain("Always read");
      expect(rules).not.toMatch(/task requirements?|verification behavior|acceptance criteria/i);
    }
  });
});
