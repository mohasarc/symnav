import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunSymnavBinaryResult } from "@symnav/testing";
import { expect } from "vitest";

export const USER_ERROR_EXIT_CODE = 1;
export const OPERATION_FAILURE_EXIT_CODE = 2;

const PLACEHOLDER_PATH_PATTERN = /(<[a-z-]+>)([^\s'"]*)/g;

export interface PathPlaceholder {
  readonly path: string;
  readonly placeholder: string;
}

export interface ExpectedErrorOutput {
  readonly exitCode?: number;
  readonly placeholders?: readonly PathPlaceholder[];
}

export class ErrorOutput {
  private static readonly snapshotsDirectory = fileURLToPath(
    new URL("./__snapshots__/", import.meta.url),
  );

  static async expectSnapshot(
    result: RunSymnavBinaryResult,
    snapshotName: string,
    expected: ExpectedErrorOutput = {},
  ): Promise<void> {
    expect(result.stdout).toBe("");
    expect(result.status).toBe(expected.exitCode ?? USER_ERROR_EXIT_CODE);
    await expect(
      ErrorOutput.normalize(result.stderr, expected.placeholders ?? []),
    ).toMatchFileSnapshot(join(ErrorOutput.snapshotsDirectory, `${snapshotName}.expected.err`));
  }

  private static normalize(stderr: string, placeholders: readonly PathPlaceholder[]): string {
    const longestPathFirst = [...placeholders].sort(
      (left, right) => right.path.length - left.path.length,
    );
    const withPlaceholders = longestPathFirst.reduce(
      (text, { path, placeholder }) =>
        text.replaceAll(path, placeholder).replaceAll(path.replaceAll("\\", "/"), placeholder),
      stderr,
    );
    return withPlaceholders.replace(
      PLACEHOLDER_PATH_PATTERN,
      (_match, placeholder: string, pathSuffix: string) =>
        `${placeholder}${pathSuffix.replaceAll("\\", "/")}`,
    );
  }
}
