import { compute } from "../math/calculator.js";

export function runOnce(): number {
  return compute(1, 2);
}

export function runTwice(): number {
  const first = compute(3, 4);
  const second = compute(5, 6);
  return first + second;
}
