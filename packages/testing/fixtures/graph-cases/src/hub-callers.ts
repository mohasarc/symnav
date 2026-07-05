import { hub } from "./hub";

export function callerOne(): number {
  return hub(1);
}

export function callerTwo(): number {
  return hub(2);
}

export function callerThree(): number {
  return hub(3);
}
