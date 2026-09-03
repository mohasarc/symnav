import { describe, expect, it, vi } from "vitest";

import { InMemoryFileSystem } from "./in-memory/in-memory-file-system.js";
import { ProjectInputCollector } from "./project-graph.js";

describe("ProjectInputCollector", () => {
  it("records successful and missing reads once in request order", () => {
    const fileSystem = new InMemoryFileSystem({
      "/repo/tsconfig.json": "root configuration",
    });
    const readFile = vi.spyOn(fileSystem, "readFileSync");
    const exists = vi.spyOn(fileSystem, "existsSync");
    const collector = new ProjectInputCollector(fileSystem);

    expect(collector.read("/repo/tsconfig.json")).toBe("root configuration");
    expect(collector.read("/repo/missing.json")).toBeUndefined();
    expect(collector.read("/repo/tsconfig.json")).toBe("root configuration");
    expect(collector.read("/repo/missing.json")).toBeUndefined();

    expect(collector.observations()).toEqual([
      { path: "/repo/tsconfig.json", content: "root configuration" },
      { path: "/repo/missing.json", content: null },
    ]);
    expect(readFile).toHaveBeenCalledOnce();
    expect(exists).toHaveBeenCalledTimes(2);
  });
});
