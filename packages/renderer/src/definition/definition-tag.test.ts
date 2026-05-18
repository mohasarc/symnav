import { describe, expect, it } from "vitest";

import { bracketTagFor } from "./definition-tag.js";

describe("bracketTagFor", () => {
  it("maps method-implementation to implementation", () => {
    expect(bracketTagFor("method-implementation")).toBe("implementation");
  });

  it("maps function-implementation to implementation", () => {
    expect(bracketTagFor("function-implementation")).toBe("implementation");
  });

  it("maps constructor-implementation to implementation", () => {
    expect(bracketTagFor("constructor-implementation")).toBe("implementation");
  });

  it("maps method-declaration to declaration", () => {
    expect(bracketTagFor("method-declaration")).toBe("declaration");
  });

  it("maps method-overload-signature to overload", () => {
    expect(bracketTagFor("method-overload-signature")).toBe("overload");
  });

  it("maps function-overload-signature to overload", () => {
    expect(bracketTagFor("function-overload-signature")).toBe("overload");
  });

  it("maps constructor-overload-signature to overload", () => {
    expect(bracketTagFor("constructor-overload-signature")).toBe("overload");
  });

  it("returns undefined for unrelated labels", () => {
    expect(bracketTagFor("class")).toBeUndefined();
    expect(bracketTagFor("variable")).toBeUndefined();
    expect(bracketTagFor("interface")).toBeUndefined();
  });
});
