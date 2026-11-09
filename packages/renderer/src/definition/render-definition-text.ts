import type { DefinitionResult, DefinitionSource, DefinitionSymbol } from "@symnav/core";
import { formatSymbolIdentity } from "@symnav/core";

import { formatHeaderLine } from "../overview/overview-format.js";
import { groupByFile } from "../shared/group-symbols-by-file.js";
import { formatIdentityPath, formatRange, treeGlyphsFor } from "../shared/render-format.js";
import { bracketTagFor } from "./definition-tag.js";

export const MAX_DEFINITION_TEXT_CHARS = 12_000;

export function renderDefinitionText(result: DefinitionResult): string {
  return DefinitionTextRenderer.render(result, MAX_DEFINITION_TEXT_CHARS);
}

interface SourceCut {
  readonly shownSourceCount: number;
}

interface CutDefinitions {
  readonly symbols: readonly DefinitionSymbol[];
  readonly hidden: readonly DefinitionSymbol[];
}

export class DefinitionTextRenderer {
  static render(result: DefinitionResult, maxChars: number): string {
    const header = `Definition: ${formatIdentityPath(result.identity)}\n\n`;
    if (result.symbols.length === 0) {
      return `${header}(no matching definitions)\n`;
    }
    const ordered = [...groupByFile(result.symbols).values()].flat();
    const renderCut = (cut: SourceCut): string =>
      header + DefinitionTextRenderer.renderCut(ordered, cut, maxChars);
    if (result.all === true) return renderCut({ shownSourceCount: ordered.length });
    return DefinitionTextRenderer.fittingText(ordered, maxChars, renderCut);
  }

  private static fittingText(
    ordered: readonly DefinitionSymbol[],
    maxChars: number,
    renderCut: (cut: SourceCut) => string,
  ): string {
    const fits = (cut: SourceCut): boolean => renderCut(cut).length <= maxChars;
    const everySource: SourceCut = { shownSourceCount: ordered.length };
    if (fits(everySource)) return renderCut(everySource);
    let shownSourceCount = 0;
    while (fits({ shownSourceCount: shownSourceCount + 1 })) shownSourceCount += 1;
    return renderCut({ shownSourceCount });
  }

  private static renderCut(
    ordered: readonly DefinitionSymbol[],
    cut: SourceCut,
    maxChars: number,
  ): string {
    const cutDefinitions = DefinitionTextRenderer.applyCut(ordered, cut);
    return (
      DefinitionTextRenderer.renderFileGroups(cutDefinitions) +
      DefinitionTextRenderer.renderCutFooter(cutDefinitions, maxChars)
    );
  }

  private static applyCut(ordered: readonly DefinitionSymbol[], cut: SourceCut): CutDefinitions {
    const hidden: DefinitionSymbol[] = [];
    const symbols = ordered.map((symbol, index): DefinitionSymbol => {
      if (symbol.source === undefined || index < cut.shownSourceCount) return symbol;
      hidden.push(symbol);
      const { source: _hiddenSource, ...signatureOnly } = symbol;
      return signatureOnly;
    });
    return { symbols, hidden };
  }

  private static renderCutFooter(cutDefinitions: CutDefinitions, maxChars: number): string {
    const { hidden } = cutDefinitions;
    if (hidden.length === 0) return "";
    const hiddenLines = hidden.map(
      (symbol) => `… source not shown: ${formatSymbolIdentity(symbol.identity)}\n`,
    );
    return (
      `… cut to fit ${maxChars} chars\n` +
      hiddenLines.join("") +
      "… more: def --source '<id>' for one definition, or --all\n"
    );
  }

  private static renderFileGroups(cutDefinitions: CutDefinitions): string {
    const groups = groupByFile(cutDefinitions.symbols);
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
