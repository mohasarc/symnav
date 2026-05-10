import type { FileSymbols } from "@symnav/core";
import { renderOverviewJson, renderOverviewText } from "@symnav/renderer";

export function writeOverviewOutput(args: {
  symbols: FileSymbols;
  json: boolean;
  stdout: NodeJS.WritableStream;
}): void {
  const rendered = args.json ? renderOverviewJson(args.symbols) : renderOverviewText(args.symbols);
  args.stdout.write(rendered);
}
