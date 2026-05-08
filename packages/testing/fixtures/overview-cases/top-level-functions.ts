export async function fetchData(url: string): Promise<string> {
  return url;
}

export function identity<T>(value: T): T {
  return value;
}

export function* counter(): Generator<number> {
  yield 1;
}
