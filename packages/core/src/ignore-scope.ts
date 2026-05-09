import type { Ignore } from "ignore";

export interface IgnoreScope {
  readonly dirRelToRoot: string;
  readonly matcher: Ignore;
}
