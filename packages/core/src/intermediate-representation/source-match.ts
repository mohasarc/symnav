export interface SourceMatch {
  readonly file: string;
  readonly line: number;
  readonly previewSource: string;
  readonly matchStart: number;
  readonly matchEnd: number;
}
