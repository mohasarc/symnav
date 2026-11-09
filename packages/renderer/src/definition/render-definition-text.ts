import type { DefinitionResult, DefinitionSource, DefinitionSymbol } from "@symnav/core";

import { formatHeaderLine } from "../overview/overview-format.js";
import { groupByFile } from "../shared/group-symbols-by-file.js";
import { formatIdentityPath, formatRange, treeGlyphsFor } from "../shared/render-format.js";
import { bracketTagFor } from "./definition-tag.js";

export function renderDefinitionText(result: DefinitionResult): string {
  return DefinitionTextRenderer.render(result);
}

class DefinitionTextRenderer {
  static render(result: DefinitionResult): string {
    const header = `Definition: ${formatIdentityPath(result.identity)}\n\n`;
    if (result.symbols.length === 0) {
      return `${header}(no matching definitions)\n`;
    }
    return header + DefinitionTextRenderer.renderFileGroups(result.symbols);
  }

  private static renderFileGroups(symbols: readonly DefinitionSymbol[]): string {
    const groups = groupByFile(symbols);
    return [...groups.entries()]
      .map(([file, group]) => DefinitionTextRenderer.renderFileGroup(file, group))
      .join("\n");
  }

  private static renderFileGroup(file: string, symbols: readonly DefinitionSymbol[]): string {
    const header = `${file}\n`;
    const entries = symbols
      .map((symbol, index) =>
        DefinitionTextRenderer.renderSymbolEntry(symbol, index === symbols.length - 1),
      )
      .join("");
    return header + entries;
  }

  private static renderSymbolEntry(symbol: DefinitionSymbol, isLast: boolean): string {
    const { branchGlyph, continuationGlyph } = treeGlyphsFor(isLast);
    const tag = bracketTagFor(symbol.kind.nativeLabel);
    const tagSuffix = tag === undefined ? "" : `  [${tag}]`;
    const head = `${branchGlyph}${formatRange(symbol.range)}: ${formatIdentityPath(symbol.identity)}${tagSuffix}\n`;
    if (symbol.source !== undefined) {
      return head + DefinitionTextRenderer.renderSource(symbol.source, continuationGlyph);
    }
    const sig = symbol.header.lines.map((line) => `${continuationGlyph}${line}\n`).join("");
    return head + sig;
  }

  private static renderSource(source: DefinitionSource, continuationGlyph: string): string {
    const lastLineNumber = source.startLine + source.lines.length - 1;
    const lineNumberWidth = String(lastLineNumber).length;
    return source.lines
      .map((line, index) => {
        const lineNumber = source.startLine + index;
        const padding = " ".repeat(lineNumberWidth - String(lineNumber).length);
        return formatHeaderLine(`${continuationGlyph}${padding}`, lineNumber, line);
      })
      .join("");
  }
}
