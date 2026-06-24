export function outer(flag: boolean): void {
  if (flag) {
    function insideIf(): void {}
    insideIf();
  }
}
