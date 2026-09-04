import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateDirectoryResolver } from "./state-directory-resolver.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("StateDirectoryResolver", () => {
  it("resolves a configured absolute directory", () => {
    const root = temporaryDirectory();

    expect(
      new StateDirectoryResolver({ SYMNAV_STATE_DIR: join(root, "state") }, "/unused").resolve(),
    ).toBe(join(realpathSync(root), "state"));
  });

  it("resolves configured relative paths and dot segments", () => {
    expect(new StateDirectoryResolver({ SYMNAV_STATE_DIR: "state/../state" }).resolve()).toBe(
      resolve("state"),
    );
  });

  it("preserves an explicitly configured empty directory", () => {
    expect(new StateDirectoryResolver({ SYMNAV_STATE_DIR: "" }, "/unused").resolve()).toBe(
      realpathSync(resolve("")),
    );
  });

  it("retains missing tail segments after canonicalizing a symlink ancestor", () => {
    const root = temporaryDirectory();
    const target = join(root, "target");
    const link = join(root, "state-link");
    mkdirSync(target);
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

    expect(StateDirectoryResolver.canonicalize(join(link, "missing", "nested"))).toBe(
      join(realpathSync(target), "missing", "nested"),
    );
  });

  it("canonicalizes an existing symlink directory", () => {
    const root = temporaryDirectory();
    const target = join(root, "target");
    const link = join(root, "state-link");
    mkdirSync(target);
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

    expect(StateDirectoryResolver.canonicalize(link)).toBe(realpathSync(target));
  });

  it("canonicalizes the filesystem root", () => {
    const fileSystemRoot = parse(resolve(process.cwd())).root;

    expect(StateDirectoryResolver.canonicalize(fileSystemRoot)).toBe(realpathSync(fileSystemRoot));
  });

  it("keeps an already canonical directory unchanged", () => {
    const canonicalDirectory = realpathSync(temporaryDirectory());

    expect(StateDirectoryResolver.canonicalize(canonicalDirectory)).toBe(canonicalDirectory);
  });

  it("uses the injected home directory when configuration is unset", () => {
    const homeDirectory = temporaryDirectory();

    expect(new StateDirectoryResolver({}, homeDirectory).resolve()).toBe(
      join(realpathSync(homeDirectory), ".symnav"),
    );
  });

  it("uses injected environment and home values without mutating global state", () => {
    const root = temporaryDirectory();
    const globalStateDirectory = process.env.SYMNAV_STATE_DIR;
    const environment: NodeJS.ProcessEnv = { SYMNAV_STATE_DIR: join(root, "configured") };

    expect(new StateDirectoryResolver(environment, join(root, "home")).resolve()).toBe(
      join(realpathSync(root), "configured"),
    );
    expect(environment).toEqual({ SYMNAV_STATE_DIR: join(root, "configured") });
    expect(process.env.SYMNAV_STATE_DIR).toBe(globalStateDirectory);
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "symnav-state-directory-"));
  temporaryDirectories.push(directory);
  return directory;
}
