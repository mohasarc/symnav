export const SIGNATURE_CAP_CHARS = 120;
export const SIGNATURE_CAP_LINES = 6;
export const SIGNATURE_ELLIPSIS = "…";

export function capSignature(source: string): string {
  if (source.length <= SIGNATURE_CAP_CHARS) {
    return source;
  }
  const head = source.slice(0, SIGNATURE_CAP_CHARS - SIGNATURE_ELLIPSIS.length);
  return head + SIGNATURE_ELLIPSIS;
}

export function capSignatureLines(lines: readonly string[]): readonly string[] {
  if (lines.length <= SIGNATURE_CAP_LINES) {
    return lines;
  }
  return [...lines.slice(0, SIGNATURE_CAP_LINES - 1), SIGNATURE_ELLIPSIS];
}
