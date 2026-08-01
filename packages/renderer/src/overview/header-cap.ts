export const HEADER_CAP_LINES = 6;
export const HEADER_CAP_LINE_LENGTH = 80;
export const HEADER_ELLIPSIS = "…";

export function capHeaderLines(lines: readonly string[]): readonly string[] {
  if (lines.length <= HEADER_CAP_LINES) {
    return lines;
  }
  return [...lines.slice(0, HEADER_CAP_LINES - 1), HEADER_ELLIPSIS];
}

export function capHeaderLineLength(line: string): string {
  if (line.length <= HEADER_CAP_LINE_LENGTH) {
    return line;
  }
  return line.slice(0, HEADER_CAP_LINE_LENGTH - 1) + HEADER_ELLIPSIS;
}

export function stripHeaderEllipsis(text: string): string {
  if (!text.endsWith(HEADER_ELLIPSIS)) {
    return text;
  }
  return text.slice(0, -HEADER_ELLIPSIS.length);
}
