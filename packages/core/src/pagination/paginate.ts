import { InvalidPageRequestError, PageOutOfRangeError } from "./errors.js";

export const DEFAULT_PAGE_SIZE = 100;

export interface PageRequest {
  readonly page?: number;
  readonly pageSize?: number;
  readonly all: boolean;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageCount: number;
}

export function paginate<T>(items: readonly T[], request: PageRequest): Page<T> {
  validate(request);
  if (request.all) {
    return { items, page: 1, pageCount: 1 };
  }
  const pageSize = request.pageSize ?? DEFAULT_PAGE_SIZE;
  const page = request.page ?? 1;
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  if (page > pageCount) {
    throw new PageOutOfRangeError(page, pageCount);
  }
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page, pageCount };
}

function validate(request: PageRequest): void {
  if (request.all && request.page !== undefined) {
    throw new InvalidPageRequestError("--all cannot be combined with an explicit page");
  }
  if (request.page !== undefined && !isPositiveInteger(request.page)) {
    throw new InvalidPageRequestError(`page must be a positive integer, got ${request.page}`);
  }
  if (request.pageSize !== undefined && !isPositiveInteger(request.pageSize)) {
    throw new InvalidPageRequestError(
      `page size must be a positive integer, got ${request.pageSize}`,
    );
  }
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
