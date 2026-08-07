import { expect } from "vitest";
import { SEGMENT_SEPARATOR, parseSegment } from "@symnav/core";

import type { JsonIdentity } from "./json-identity.js";

export function expectIdentity(identity: JsonIdentity, canonicalId: string): void {
  const [file, ...segments] = canonicalId.split(SEGMENT_SEPARATOR);
  expect(identity).toEqual({
    file,
    segments: segments.map((segment) => parseSegment(segment, canonicalId)),
  });
}
