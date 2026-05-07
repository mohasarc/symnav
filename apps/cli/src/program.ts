import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, "..", "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version: string };
  return parsed.version;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("symnav")
    .version(readPackageVersion(), "-v, --version")
    .action(() => {
      program.outputHelp({ error: true });
      process.exit(1);
    });
  return program;
}
