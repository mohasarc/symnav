export function hub(value: number): number {
  const first = spokeOne(value);
  const second = spokeTwo(first);
  return spokeThree(second);
}

export function spokeOne(value: number): number {
  return value + 1;
}

export function spokeTwo(value: number): number {
  return value * 2;
}

export function spokeThree(value: number): number {
  return value - 3;
}
