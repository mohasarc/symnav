export const HEADER_CAP_LINES = 6;
export const HEADER_ELLIPSIS = "…";

export function capHeaderLines(lines: readonly string[]): readonly string[] {
  if (lines.length <= HEADER_CAP_LINES) {
    return lines;
  }
  return [...lines.slice(0, HEADER_CAP_LINES - 1), HEADER_ELLIPSIS];
}
