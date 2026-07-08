export function parse(input: URLSearchParams): Record<string, string> {
  return Object.fromEntries(input.entries());
}
