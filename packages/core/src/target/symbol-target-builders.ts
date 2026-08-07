import type { SymbolIdentity } from "../intermediate-representation/symbol-identity.js";
import type { Header } from "../intermediate-representation/types.js";
import type { SymbolOverviewNode } from "../intermediate-representation/overview-tree.js";
import type { SymbolTargetCandidate } from "./symbol-target-result.js";

export function identity(file: string, ...names: readonly string[]): SymbolIdentity {
  return { file, segments: names.map((name) => ({ name })) };
}

export function candidate(
  file: string,
  names: readonly string[],
  headerLines: readonly string[],
): SymbolTargetCandidate {
  const header: Header = { startLine: 1, lines: headerLines };
  const symbol: SymbolOverviewNode = {
    type: "symbol",
    identity: identity(file, ...names),
    kind: { role: "callable", nativeLabel: "function" },
    range: { startLine: 1, endLine: 1 },
    header,
    children: [],
  };
  return { symbol, canonicalId: `${file}::${names.join("::")}`, header };
}
