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
  readonly firstSourceLineCount?: number;
}

interface PartialSource {
  readonly symbol: DefinitionSymbol;
  readonly omittedLineCount: number;
}

interface CutDefinitions {
  readonly symbols: readonly DefinitionSymbol[];
  readonly hidden: readonly DefinitionSymbol[];
  readonly partial: PartialSource | undefined;
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
    if (shownSourceCount > 0) return renderCut({ shownSourceCount });
    const firstSourceLineCount = DefinitionTextRenderer.mostFittingFirstSourceLines(
      ordered[0]?.source?.lines.length ?? 0,
      fits,
    );
    if (firstSourceLineCount === 0) return renderCut({ shownSourceCount: 0 });
    return renderCut({ shownSourceCount: 0, firstSourceLineCount });
  }

  private static mostFittingFirstSourceLines(
    lineCount: number,
    fits: (cut: SourceCut) => boolean,
  ): number {
    let low = 0;
    let high = lineCount - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits({ shownSourceCount: 0, firstSourceLineCount: middle })) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return low;
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
    let partial: PartialSource | undefined;
    const symbols = ordered.map((symbol, index): DefinitionSymbol => {
      if (symbol.source === undefined || index < cut.shownSourceCount) return symbol;
      const isPartialFirst = index === 0 && cut.firstSourceLineCount !== undefined;
      if (isPartialFirst) {
        const shownLines = symbol.source.lines.slice(0, cut.firstSourceLineCount);
        const partialSymbol: DefinitionSymbol = {
          ...symbol,
          source: { ...symbol.source, lines: shownLines },
        };
        partial = {
          symbol: partialSymbol,
          omittedLineCount: symbol.source.lines.length - shownLines.length,
        };
        return partialSymbol;
      }
      hidden.push(symbol);
      const { source: _hiddenSource, ...signatureOnly } = symbol;
      return signatureOnly;
    });
    return { symbols, hidden, partial };
  }

  private static renderCutFooter(cutDefinitions: CutDefinitions, maxChars: number): string {
    const { hidden, partial } = cutDefinitions;
    if (hidden.length === 0 && partial === undefined) return "";
    const hiddenLines = hidden.map(
      (symbol) => `… source not shown: ${formatSymbolIdentity(symbol.identity)}\n`,
    );
    const offersMemberHint = partial !== undefined && partial.symbol.kind.role === "container";
    const hints = [
      ...(offersMemberHint ? [DefinitionTextRenderer.memberHint(partial.symbol)] : []),
      ...(hidden.length > 0 ? ["def --source '<id>' for one definition"] : []),
      "--all",
    ];
    return (
      `… cut to fit ${maxChars} chars\n` +
      hiddenLines.join("") +
      `… more: ${DefinitionTextRenderer.joinHints(hints)}\n`
    );
  }

  private static memberHint(symbol: DefinitionSymbol): string {
    const symbolPath = formatIdentityPath(symbol.identity);
    return `overview ${symbol.identity.file} --at '${symbolPath}' --depth 1 then def --source on a member`;
  }

  private static joinHints(hints: readonly string[]): string {
    const lastHint = hints[hints.length - 1] ?? "";
    if (hints.length === 1) return lastHint;
    return `${hints.slice(0, -1).join(", ")}, or ${lastHint}`;
  }

  private static renderFileGroups(cutDefinitions: CutDefinitions): string {
    const groups = groupByFile(cutDefinitions.symbols);
    return [...groups.entries()]
      .map(([file, group]) =>
        DefinitionTextRenderer.renderFileGroup(file, group, cutDefinitions.partial),
      )
      .join("\n");
  }

  private static renderFileGroup(
    file: string,
    symbols: readonly DefinitionSymbol[],
    partial: PartialSource | undefined,
  ): string {
    const header = `${file}\n`;
    const entries = symbols
      .map((symbol, index) =>
        DefinitionTextRenderer.renderSymbolEntry(symbol, index === symbols.length - 1, partial),
      )
      .join("");
    return header + entries;
  }

  private static renderSymbolEntry(
    symbol: DefinitionSymbol,
    isLast: boolean,
    partial: PartialSource | undefined,
  ): string {
    const { branchGlyph, continuationGlyph } = treeGlyphsFor(isLast);
    const tag = bracketTagFor(symbol.kind.nativeLabel);
    const tagSuffix = tag === undefined ? "" : `  [${tag}]`;
    const head = `${branchGlyph}${formatRange(symbol.range)}: ${formatIdentityPath(symbol.identity)}${tagSuffix}\n`;
    if (symbol.source !== undefined) {
      const omittedNote =
        partial?.symbol === symbol
          ? DefinitionTextRenderer.renderOmittedNote(symbol.source, partial, continuationGlyph)
          : "";
      return (
        head + DefinitionTextRenderer.renderSource(symbol.source, continuationGlyph) + omittedNote
      );
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

  private static renderOmittedNote(
    source: DefinitionSource,
    partial: PartialSource,
    continuationGlyph: string,
  ): string {
    const firstOmittedLine = source.startLine + source.lines.length;
    const lastOmittedLine = firstOmittedLine + partial.omittedLineCount - 1;
    return `${continuationGlyph}… omitted: lines ${firstOmittedLine}-${lastOmittedLine} (${partial.omittedLineCount} lines)\n`;
  }
}
