import { describe, expect, it } from "vitest";

import { InvalidPageRequestError } from "./errors.js";
import { validatePageRequest } from "./validate-page-request.js";

describe("validatePageRequest", () => {
  it.each([0, -1, 1.5, Number.NaN])("rejects page %s", (page) => {
    expect(() => validatePageRequest({ page, all: false })).toThrowError(
      InvalidPageRequestError,
    );
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects page size %s", (pageSize) => {
    expect(() => validatePageRequest({ pageSize, all: false })).toThrowError(
      InvalidPageRequestError,
    );
  });

  it("rejects an explicit page combined with all", () => {
    expect(() => validatePageRequest({ page: 2, all: true })).toThrowError(
      InvalidPageRequestError,
    );
  });
});
