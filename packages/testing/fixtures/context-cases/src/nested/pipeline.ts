import { transform } from "./transform.js";

export function runPipeline(values: readonly number[]): number[] {
  const out: number[] = [];
  for (const value of values) {
    if (value > 0) {
      out.push(transform(value));
    }
  }
  return out;
}

export function mapAll(values: readonly number[]): number[] {
  return values.map((value) => transform(value));
}
