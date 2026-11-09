import { describe, expect, it } from "vitest";

import { InMemoryFileSystem } from "../workspace/in-memory/in-memory-file-system.js";
import type { ResolvedPath } from "../workspace/workspace.js";
import { DefinitionSourceReader } from "./definition-source-reader.js";

const FILE: ResolvedPath = { relative: "src/a.ts", absolute: "/repo/src/a.ts" };

class ReaderScenario {
  static readerFor(content: string): DefinitionSourceReader {
    return new DefinitionSourceReader(new InMemoryFileSystem({ [FILE.absolute]: content }));
  }
}

describe("DefinitionSourceReader", () => {
  it("reads the lines of a range, both ends inclusive", async () => {
    const reader = ReaderScenario.readerFor("one\n  two\n  three\nfour\n");

    const source = await reader.read(FILE, { startLine: 2, endLine: 3 });

    expect(source).toEqual({ startLine: 2, lines: ["  two", "  three"] });
  });

  it("splits CRLF line endings without keeping the carriage return", async () => {
    const reader = ReaderScenario.readerFor("one\r\ntwo\r\nthree\r\n");

    const source = await reader.read(FILE, { startLine: 1, endLine: 2 });

    expect(source).toEqual({ startLine: 1, lines: ["one", "two"] });
  });

  it("reads a last line that has no trailing newline", async () => {
    const reader = ReaderScenario.readerFor("one\ntwo");

    const source = await reader.read(FILE, { startLine: 2, endLine: 2 });

    expect(source).toEqual({ startLine: 2, lines: ["two"] });
  });
});
