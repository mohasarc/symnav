import type { Reference } from "@symnav/core";

export const PREVIEW_WIDTH = 80;

const PREVIEW_ELLIPSIS = "…";

export function trimPreview(reference: Reference): string {
  const { text, matchStart, matchEnd } = stripSurroundingWhitespace(reference);
  if (text.length <= PREVIEW_WIDTH) {
    return text;
  }
  if (matchEnd <= PREVIEW_WIDTH - 1) {
    return text.slice(0, PREVIEW_WIDTH - 1) + PREVIEW_ELLIPSIS;
  }
  const tailWindowStart = text.length - (PREVIEW_WIDTH - 1);
  if (matchStart >= tailWindowStart) {
    return PREVIEW_ELLIPSIS + text.slice(tailWindowStart);
  }
  const windowWidth = PREVIEW_WIDTH - 2;
  return PREVIEW_ELLIPSIS + text.slice(matchStart, matchStart + windowWidth) + PREVIEW_ELLIPSIS;
}

export function fullPreview(reference: Reference): string {
  return reference.previewSource;
}

interface StrippedPreview {
  readonly text: string;
  readonly matchStart: number;
  readonly matchEnd: number;
}

function stripSurroundingWhitespace(reference: Reference): StrippedPreview {
  const text = reference.previewSource.trim();
  const leadingWidth = reference.previewSource.length - reference.previewSource.trimStart().length;
  const matchStart = Math.max(0, reference.matchStart - leadingWidth);
  const matchEnd = Math.min(text.length, Math.max(matchStart, reference.matchEnd - leadingWidth));
  return { text, matchStart, matchEnd };
}
