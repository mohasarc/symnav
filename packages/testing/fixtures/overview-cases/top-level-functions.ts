export function greet(name: string): string {
  return `hello, ${name}`;
}

export async function loadJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  return (await res.json()) as T;
}

export function add(a: number, b: number): number;
export function add(a: string, b: string): string;
export function add(a: number | string, b: number | string): number | string {
  return (a as number) + (b as number);
}
