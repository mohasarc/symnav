export function splitHeaderLines(raw: string): string[] {
  return raw.split(/\r?\n/);
}
