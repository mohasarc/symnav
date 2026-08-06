export interface JsonIdentity {
  file: string;
  segments: readonly { name: string; disambiguator?: number }[];
}

export interface JsonSymbol {
  identity: JsonIdentity;
}
