export function createContainer() {
  const initializedValues = new Map<string, number>();
  function initialize(): void { initializedValues.clear(); }
  return { initialize };
}
