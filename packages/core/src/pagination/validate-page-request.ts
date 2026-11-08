import { isPositiveInteger } from "../validation/is-positive-integer.js";
import { InvalidPageRequestError } from "./errors.js";
import type { PageRequest } from "./paginator.js";

export interface PageRequestInput {
  readonly page?: number | string;
  readonly pageSize?: number | string;
  readonly all: boolean;
}

export function validatePageRequest(request: PageRequestInput): PageRequest {
  const { all, page, pageSize } = request;
  if (all && page !== undefined) {
    throw new InvalidPageRequestError("--all cannot be combined with an explicit page");
  }
  const numericPage = page === undefined ? undefined : Number(page);
  if (numericPage !== undefined && !isPositiveInteger(numericPage)) {
    throw new InvalidPageRequestError(`page must be a positive integer, got ${page}`);
  }
  const numericPageSize = pageSize === undefined ? undefined : Number(pageSize);
  if (numericPageSize !== undefined && !isPositiveInteger(numericPageSize)) {
    throw new InvalidPageRequestError(`page size must be a positive integer, got ${pageSize}`);
  }
  return {
    ...(numericPage !== undefined && { page: numericPage }),
    ...(numericPageSize !== undefined && { pageSize: numericPageSize }),
    all,
  };
}
