export function nestedTarget(value: string): string {
  return value;
}

export function nestedCaller(): string {
  return nestedTarget("nested");
}
