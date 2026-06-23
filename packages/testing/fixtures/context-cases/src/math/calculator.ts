import { add, multiply } from "./operations.js";

export function compute(a: number, b: number): number {
  const sum = add(a, b);
  const scaled = multiply(sum, 2);
  return scaled;
}
