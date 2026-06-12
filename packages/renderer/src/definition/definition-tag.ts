const TAG_BY_LABEL: ReadonlyMap<string, string> = new Map([
  ["method-implementation", "implementation"],
  ["function-implementation", "implementation"],
  ["constructor-implementation", "implementation"],
  ["method-declaration", "declaration"],
  ["method-overload-signature", "overload"],
  ["function-overload-signature", "overload"],
  ["constructor-overload-signature", "overload"],
]);

export function bracketTagFor(nativeLabel: string): string | undefined {
  return TAG_BY_LABEL.get(nativeLabel);
}
