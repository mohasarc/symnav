import type { GraphPath } from "../graph/graph-path.js";
import { InvalidPageRequestError, PageOutOfRangeError } from "../pagination/errors.js";
import { DEFAULT_PAGE_SIZE, type PageRequest } from "../pagination/paginator.js";
import { validatePageRequest } from "../pagination/validate-page-request.js";
import { formatSymbolIdentity } from "./canonical-identity.js";
import type { GraphDirection, GraphDirectionPage, GraphResult } from "./graph-result.js";
import type { SymbolIdentity } from "./symbol-identity.js";
import type { SymbolDecl } from "./types.js";

export interface BuildGraphResultArgs {
  readonly identity: SymbolIdentity;
  readonly root: SymbolDecl;
  readonly depth: number;
  readonly direction: GraphDirection;
  readonly incomingPaths: readonly GraphPath[];
  readonly outgoingPaths: readonly GraphPath[];
  readonly pageRequest: PageRequest;
}

export class GraphResultBuilder {
  constructor(private readonly args: BuildGraphResultArgs) {}

  build(): GraphResult {
    validatePageRequest(this.args.pageRequest);
    this.validateGraphPageRequest();
    const directionPages = this.directionPages();
    const pageCount = this.pageCount(directionPages);
    const page = this.args.pageRequest.all ? 1 : (this.args.pageRequest.page ?? 1);
    if (page > pageCount) {
      throw new PageOutOfRangeError(page, pageCount);
    }
    const incoming = this.pageFor(directionPages.incoming, page);
    const outgoing = this.pageFor(directionPages.outgoing, page);
    return {
      identity: this.args.identity,
      root: this.args.root,
      depth: this.args.depth,
      direction: this.args.direction,
      ...(incoming === undefined ? {} : { incoming }),
      ...(outgoing === undefined ? {} : { outgoing }),
      page,
      pageCount,
      repeatedSymbolCount: this.countRepeatedSymbols([
        ...(incoming?.paths ?? []),
        ...(outgoing?.paths ?? []),
      ]),
    };
  }

  private validateGraphPageRequest(): void {
    const pageSize = this.args.pageRequest.pageSize ?? DEFAULT_PAGE_SIZE;
    if (this.args.direction === "both" && pageSize < 2 && !this.args.pageRequest.all) {
      throw new InvalidPageRequestError(
        `page size must be at least 2 when graph direction is both, got ${pageSize}`,
      );
    }
  }

  private directionPages(): DirectionPages {
    if (this.args.pageRequest.all) {
      return {
        ...(this.includesIncoming()
          ? { incoming: this.allDirectionPage(this.args.incomingPaths) }
          : {}),
        ...(this.includesOutgoing()
          ? { outgoing: this.allDirectionPage(this.args.outgoingPaths) }
          : {}),
      };
    }
    const budget = this.directionBudget();
    return {
      ...(this.includesIncoming()
        ? { incoming: this.directionPage(this.args.incomingPaths, budget.incoming) }
        : {}),
      ...(this.includesOutgoing()
        ? { outgoing: this.directionPage(this.args.outgoingPaths, budget.outgoing) }
        : {}),
    };
  }

  private pageCount(directionPages: DirectionPages): number {
    const counts = [directionPages.incoming?.pageCount, directionPages.outgoing?.pageCount].filter(
      (count): count is number => count !== undefined,
    );
    return Math.max(1, ...counts);
  }

  private pageFor(page: DirectionPageSlices | undefined, pageNumber: number) {
    if (page === undefined) {
      return undefined;
    }
    return {
      paths: page.pathsByPage[pageNumber - 1] ?? [],
      totalPathCount: page.totalPathCount,
    };
  }

  private allDirectionPage(paths: readonly GraphPath[]): DirectionPageSlices {
    return {
      pathsByPage: [paths],
      totalPathCount: paths.length,
      pageCount: 1,
    };
  }

  private directionPage(paths: readonly GraphPath[], budget: number): DirectionPageSlices {
    return {
      pathsByPage: this.pages(paths, budget),
      totalPathCount: paths.length,
      pageCount: this.directionPageCount(paths.length, budget),
    };
  }

  private pages(paths: readonly GraphPath[], budget: number): readonly (readonly GraphPath[])[] {
    if (budget <= 0) {
      return [[]];
    }
    const pages: GraphPath[][] = [];
    for (let start = 0; start < paths.length; start += budget) {
      pages.push(paths.slice(start, start + budget));
    }
    return pages.length === 0 ? [[]] : pages;
  }

  private directionPageCount(totalPathCount: number, budget: number): number {
    if (budget <= 0) {
      return 1;
    }
    return Math.max(1, Math.ceil(totalPathCount / budget));
  }

  private directionBudget(): DirectionBudget {
    const pageSize = this.args.pageRequest.pageSize ?? DEFAULT_PAGE_SIZE;
    if (this.args.direction === "both") {
      return {
        incoming: Math.ceil(pageSize / 2),
        outgoing: Math.floor(pageSize / 2),
      };
    }
    return { incoming: pageSize, outgoing: pageSize };
  }

  private includesIncoming(): boolean {
    return this.args.direction === "incoming" || this.args.direction === "both";
  }

  private includesOutgoing(): boolean {
    return this.args.direction === "outgoing" || this.args.direction === "both";
  }

  private countRepeatedSymbols(paths: readonly GraphPath[]): number {
    const rootId = formatSymbolIdentity(this.args.identity);
    const pathsBySymbol = new Map<string, number>();
    for (const path of paths) {
      for (const symbolId of this.uniqueNonRootSymbolIds(path, rootId)) {
        pathsBySymbol.set(symbolId, (pathsBySymbol.get(symbolId) ?? 0) + 1);
      }
    }
    return Array.from(pathsBySymbol.values()).filter((count) => count > 1).length;
  }

  private uniqueNonRootSymbolIds(path: GraphPath, rootId: string): Set<string> {
    const symbolIds = new Set<string>();
    for (const step of path.steps) {
      const symbolId = formatSymbolIdentity(step.symbol.identity);
      if (symbolId !== rootId) {
        symbolIds.add(symbolId);
      }
    }
    return symbolIds;
  }
}

interface DirectionBudget {
  readonly incoming: number;
  readonly outgoing: number;
}

interface DirectionPages {
  readonly incoming?: DirectionPageSlices;
  readonly outgoing?: DirectionPageSlices;
}

interface DirectionPageSlices {
  readonly pathsByPage: readonly (readonly GraphPath[])[];
  readonly pageCount: number;
  readonly totalPathCount: GraphDirectionPage["totalPathCount"];
}
