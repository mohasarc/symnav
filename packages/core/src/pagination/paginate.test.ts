import { describe, expect, it } from "vitest";

import { InvalidPageRequestError, PageOutOfRangeError } from "./errors.js";
import { DEFAULT_PAGE_SIZE, paginate } from "./paginate.js";

function numbered(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}

describe("paginate", () => {
  it("defaults to the first page of 100", () => {
    const page = paginate(numbered(250), { all: false });
    expect(page.items).toEqual(numbered(100));
    expect(page.page).toBe(1);
    expect(page.pageCount).toBe(3);
  });

  it("exports the default page size", () => {
    expect(DEFAULT_PAGE_SIZE).toBe(100);
  });

  it("returns the requested page", () => {
    const page = paginate(numbered(250), { page: 3, all: false });
    expect(page.items).toEqual(numbered(250).slice(200));
    expect(page.page).toBe(3);
  });

  it("honors a custom page size", () => {
    const page = paginate(numbered(7), { page: 2, pageSize: 3, all: false });
    expect(page.items).toEqual([4, 5, 6]);
    expect(page.pageCount).toBe(3);
  });

  it("returns everything as one page with all", () => {
    const page = paginate(numbered(250), { all: true });
    expect(page.items).toEqual(numbered(250));
    expect(page.page).toBe(1);
    expect(page.pageCount).toBe(1);
  });

  it("treats empty input as a valid single page", () => {
    const page = paginate([], { all: false });
    expect(page.items).toEqual([]);
    expect(page.page).toBe(1);
    expect(page.pageCount).toBe(1);
  });

  it("throws when the page is beyond the page count", () => {
    expect(() => paginate(numbered(7), { page: 5, pageSize: 3, all: false })).toThrowError(
      PageOutOfRangeError,
    );
  });

  it("names the requested page and page count in the out-of-range reason", () => {
    let caught: unknown;
    try {
      paginate(numbered(7), { page: 5, pageSize: 3, all: false });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PageOutOfRangeError);
    const reason = (caught as PageOutOfRangeError).reason;
    expect(reason).toContain("5");
    expect(reason).toContain("3");
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects page %s", (page) => {
    expect(() => paginate(numbered(7), { page, all: false })).toThrowError(InvalidPageRequestError);
  });

  it.each([0, Number.NaN])("rejects page size %s", (pageSize) => {
    expect(() => paginate(numbered(7), { pageSize, all: false })).toThrowError(
      InvalidPageRequestError,
    );
  });

  it("rejects an explicit page combined with all", () => {
    expect(() => paginate(numbered(7), { page: 2, all: true })).toThrowError(
      InvalidPageRequestError,
    );
  });
});
