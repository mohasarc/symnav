/**
 * JSDoc that should never leak into command output.
 */
export function leakyFunction(input: string): string {
  throw new Error("body throw should stay hidden");
  return input.toUpperCase();
}

export function callsLeakyFunction(): string {
  return leakyFunction("visible-call");
}

export interface HeaderContract {
  readHeader(name: string): string;
}

export type HeaderAlias = {
  name: string;
  enabled: boolean;
};

export enum HeaderMode {
  Read = "read",
  Write = "write",
}

export namespace HeaderNamespace {
  export const defaultName = "x-header";

  export function normalizeName(name: string): string {
    return name.toLowerCase();
  }
}

export class HeaderService implements HeaderContract {
  private readonly prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  get label(): string {
    return `${this.prefix}:label`;
  }

  readHeader(name: string): string {
    return `${this.prefix}:${name}`;
  }
}

export function overloads(input: string): string;
export function overloads(input: number): number;
export function overloads(input: string | number): string | number {
  return input;
}

export const arrowHelper = (value: string): string => {
  return value.trim();
};

export const functionHelper = function headerFunction(value: string): string {
  return value.trim();
};

export const schema = z.object({
  privateKey: z.string(),
  nested: z.object({
    shouldStayHidden: z.string(),
  }),
});

export const values = [
  "array-body-alpha",
  "array-body-beta",
];

export const callResult = functionHelper("ready");
