import { describe, expect, it } from "vitest";

import { FlowPragmaDetector } from "./flow-pragma-detector.js";

describe("FlowPragmaDetector.hasFlowPragma", () => {
  it.each([
    ["a line comment", "// @flow\nexport const x = 1;\n"],
    ["a block comment with a mode", "/* @flow strict */\nexport const x = 1;\n"],
    ["a JSDoc @noflow", "/**\n * @noflow\n */\nexport const x = 1;\n"],
    ["a later leading comment", "// Copyright\n\n/* @flow */\nexport const x = 1;\n"],
    ["a comment after a shebang", "#!/usr/bin/env node\n// @flow\nexport const x = 1;\n"],
    [
      "a comment after a byte order mark and a shebang",
      "\uFEFF#!/usr/bin/env node\n// @flow\nexport const x = 1;\n",
    ],
    ["a pragma closing its comment", "/* @flow*/\nexport const x = 1;\n"],
  ])("detects a pragma in %s", (_case, text) => {
    expect(FlowPragmaDetector.hasFlowPragma(text)).toBe(true);
  });

  it.each([
    ["a file without comments", "export const x = 1;\n"],
    ["a comment after the first token", "export const x = 1;\n// @flow\n"],
    ["code mentioning the pragma", 'const pragma = "@flow";\n'],
    ["a longer tag", "// @flowtype\nexport const x = 1;\n"],
    ["a hyphenated tag", "// requires @flow-typed defs\nexport const x = 1;\n"],
    ["an email address", "// mail bob@flow.io\nexport const x = 1;\n"],
    ["a shebang alone", "#!/usr/bin/env node @flow\nexport const x = 1;\n"],
  ])("ignores %s", (_case, text) => {
    expect(FlowPragmaDetector.hasFlowPragma(text)).toBe(false);
  });
});
