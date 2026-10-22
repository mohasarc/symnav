import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

class DaemonProductionBoundary {
  static files(sourceRoot: string): readonly string[] {
    return DaemonProductionBoundary.walk(sourceRoot).filter(
      (path) => path.endsWith(".ts") && !path.endsWith(".test.ts"),
    );
  }

  static violations(sourceRoot: string): readonly string[] {
    return DaemonProductionBoundary.files(sourceRoot).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      const forbidden = [
        /from ["']@symnav\/(?:core|telemetry|renderer|backend-typescript|testing)["']/,
        /from ["'][^"']*apps\/cli[^"']*["']/,
      ];
      return forbidden.some((pattern) => pattern.test(source)) ? [relative(sourceRoot, path)] : [];
    });
  }

  private static walk(directory: string): readonly string[] {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? DaemonProductionBoundary.walk(path) : [path];
    });
  }
}

describe("daemon package production boundary", () => {
  it("has no internal production dependency or CLI import", () => {
    const sourceRoot = dirname(fileURLToPath(import.meta.url));
    expect(DaemonProductionBoundary.violations(sourceRoot)).toEqual([]);
  });
});
