import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";

import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";

const fixtureRoot = fixturePath("javascript-cases");
const snapshotsDir = fileURLToPath(new URL("./__snapshots__/", import.meta.url));
const componentDidUpdate = "Tabs.js::Tabs::componentDidUpdate";

function runSymnav(args: readonly string[]) {
  return runSymnavBinary(args, { cwd: fixtureRoot });
}

function expectAnswer(args: readonly string[]): string {
  const r = runSymnav(args);
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  return r.stdout;
}

beforeAll(() => {
  ensureFixtureGitMarker(fixtureRoot);
});

describe("symnav e2e on JavaScript sources", () => {
  it("prints the overview of a JSX class component in a .js file", async () => {
    const stdout = expectAnswer(["overview", "src/Tabs/Tabs.js", "--depth", "2"]);
    await expect(stdout).toMatchFileSnapshot(join(snapshotsDir, "tabs-overview.expected.txt"));
  });

  it("prints the overview of a .cjs file", () => {
    expect(expectAnswer(["overview", "src/legacy.cjs"])).toContain("1-3: legacyFormat");
  });

  it("resolves a class declared in a .js file", () => {
    expect(expectAnswer(["resolve", "Tabs"])).toContain(
      "└── src/Tabs/Tabs.js\n    └── 9-30: Tabs\n        class Tabs extends React.Component",
    );
  });

  it("finds the definition of a .js class", () => {
    expect(expectAnswer(["def", "Tabs.js::Tabs"])).toContain(
      "src/Tabs/Tabs.js\n└── 9-30: Tabs\n    class Tabs extends React.Component",
    );
  });

  it("finds references from a .jsx consumer and a .js barrel", () => {
    const stdout = expectAnswer(["refs", "Tabs.js::Tabs"]);
    expect(stdout).toContain('1: import { Tabs } from "./Tabs/index.js";  [import]');
    expect(stdout).toContain("4: return <Tabs value={1} />;  [usage]");
    expect(stdout).toContain('1: export { default, Tabs } from "./Tabs.js";  [export]');
  });

  it("resolves a bare name to the .js class over its .d.ts twin", () => {
    const stdout = expectAnswer(["refs", "Tabs"]);
    expect(stdout).toContain("32: Tabs.propTypes = {  [usage]");
    expect(stdout).toContain('1: import { Tabs } from "./Tabs/index.js";  [import]');
  });

  it("lists a .js method's callee in its context", () => {
    expect(expectAnswer(["context", componentDidUpdate])).toContain(
      "Callees\nsrc/Tabs/Tabs.js\n└── 22-24: Tabs::updateIndicatorState  [call]",
    );
  });

  it("follows outgoing calls from a .js method", () => {
    expect(expectAnswer(["graph", componentDidUpdate, "--outgoing"])).toContain(
      "22-24: Tabs::updateIndicatorState  [callee]",
    );
  });

  it("finds a .ts importer of a .mjs function", () => {
    const stdout = expectAnswer(["refs", "lib.mjs::shout"]);
    expect(stdout).toContain(
      'src/use.ts\n├── 1: import { shout } from "./lib.mjs";  [import]\n└── 4: return shout(name);  [usage]',
    );
  });
});
