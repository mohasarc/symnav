import { describe, expect, it } from "vitest";

import { roleOf } from "./typescript-symbol-kind.js";

describe("roleOf", () => {
  it("maps a class to the container role", () => {
    expect(roleOf("class")).toBe("container");
  });

  it("maps a method to the callable role", () => {
    expect(roleOf("method")).toBe("callable");
  });

  it("maps a variable to the value role", () => {
    expect(roleOf("variable")).toBe("value");
  });

  it("maps a type alias to the type role", () => {
    expect(roleOf("type-alias")).toBe("type");
  });

  it("maps the signature kinds to a role", () => {
    expect(roleOf("index-signature")).toBe("type");
    expect(roleOf("call-signature")).toBe("callable");
    expect(roleOf("construct-signature")).toBe("callable");
  });
});
