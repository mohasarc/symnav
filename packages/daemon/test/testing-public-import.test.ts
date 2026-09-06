import { describe, expect, expectTypeOf, it } from "vitest";
import * as testingRuntime from "@symnav/daemon/testing";
import {
  DaemonTestingInspector,
  type DaemonTestingDiagnosticEvent,
  type DaemonTestingDiagnosticPage,
  type DaemonTestingInstance,
  type DaemonTestingSpoolUsage,
} from "@symnav/daemon/testing";

describe("@symnav/daemon/testing public import", () => {
  it("exports the exact read-only testing surface", () => {
    expect(Object.keys(testingRuntime)).toEqual(["DaemonTestingInspector"]);
    expect(DaemonTestingInspector).toBeTypeOf("function");
    expectTypeOf<DaemonTestingInstance>().toBeObject();
    expectTypeOf<DaemonTestingDiagnosticEvent>().toBeObject();
    expectTypeOf<DaemonTestingDiagnosticPage>().toBeObject();
    expectTypeOf<DaemonTestingSpoolUsage>().toBeObject();
  });
});
