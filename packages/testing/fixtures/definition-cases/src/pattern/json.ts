export function parse(input: string): unknown {
  return JSON.parse(input) as unknown;
}
