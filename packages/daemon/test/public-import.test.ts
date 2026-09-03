import { describe, expect, expectTypeOf, it } from "vitest";

import * as daemonRuntime from "@symnav/daemon";
import type {
  DaemonActivitySnapshot,
  DaemonExecutor,
  DaemonStartResult,
  DaemonStatusEnvelope,
  DaemonStopResult,
} from "@symnav/daemon";

describe("@symnav/daemon public package import", () => {
  it("resolves the root contract without a runtime surface", () => {
    expectTypeOf<DaemonExecutor>().toBeObject();
    expectTypeOf<DaemonActivitySnapshot>().toBeObject();
    expectTypeOf<DaemonStatusEnvelope>().toBeObject();
    expectTypeOf<DaemonStartResult>().not.toBeNever();
    expectTypeOf<DaemonStopResult>().not.toBeNever();
    expect(Object.keys(daemonRuntime)).toEqual([]);
  });
});
