export interface JsonIdentity {
  file: string;
  segments: readonly { name: string }[];
}

export interface JsonSymbol {
  identity: JsonIdentity;
}
