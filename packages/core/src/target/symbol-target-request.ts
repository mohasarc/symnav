import { compileRegex } from "../validation/compile-regex.js";
import { formatSymbolIdentity } from "../intermediate-representation/canonical-identity.js";
import type { SymbolIdentity } from "../intermediate-representation/symbol-identity.js";
import { SymbolTargetGrammar } from "./symbol-target-pattern.js";
import type { SymbolTargetPattern } from "./symbol-target-pattern.js";

export type SymbolTargetRequest =
  | {
      readonly mode: "regular";
      readonly raw: string;
      readonly pattern: SymbolTargetPattern;
    }
  | {
      readonly mode: "regex";
      readonly raw: string;
      readonly expression: RegExp;
    };

export class SymbolTargetRequestParser {
  static parse(raw: string, regex: boolean): SymbolTargetRequest {
    if (regex) {
      return { mode: "regex", raw, expression: compileRegex(raw) };
    }
    return { mode: "regular", raw, pattern: SymbolTargetGrammar.parse(raw) };
  }
}

export class SymbolTargetRequestMatcher {
  static matches(request: SymbolTargetRequest, identity: SymbolIdentity): boolean {
    if (request.mode === "regex") {
      return request.expression.test(formatSymbolIdentity(identity));
    }
    return SymbolTargetGrammar.matches(request.pattern, identity);
  }
}
