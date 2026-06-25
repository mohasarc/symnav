export function outer(flag: boolean, items: readonly string[]): void {
  if (flag) {
    function insideIf(): void {}
    insideIf();
  }

  for (const item of items) {
    const insideLoop = item;
    void insideLoop;
  }
}
