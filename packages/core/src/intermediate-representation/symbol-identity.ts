export interface SymbolPathSegment {
  readonly name: string;
  readonly disambiguator?: number;
}

export interface SymbolIdentity {
  readonly file: string;
  readonly segments: readonly SymbolPathSegment[];
}
