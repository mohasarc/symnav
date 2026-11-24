import { add } from "@lib/math";
import { Badge } from "./Badge";

export function total(left: number, right: number): number {
  return add(left, right);
}

export const badge = Badge;
