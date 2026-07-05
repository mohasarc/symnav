import { PageOutOfRangeError } from "./errors.js";
import { validatePageRequest } from "./validate-page-request.js";

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

export class Paginator {
  constructor(private readonly request: PageRequest) {
    validatePageRequest(request);
  }

  paginate<T>(items: readonly T[]): Page<T> {
    if (this.request.all) {
      return { items, page: 1, pageCount: 1 };
    }
    const pageSize = this.request.pageSize ?? DEFAULT_PAGE_SIZE;
    const page = this.request.page ?? 1;
    const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
    if (page > pageCount) {
      throw new PageOutOfRangeError(page, pageCount);
    }
    const start = (page - 1) * pageSize;
    return { items: items.slice(start, start + pageSize), page, pageCount };
  }
}
