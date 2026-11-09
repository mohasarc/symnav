export class JavaScriptDeclarationTwin {
  private static readonly DECLARATION_EXTENSION_BY_JAVASCRIPT_EXTENSION: ReadonlyMap<
    string,
    string
  > = new Map([
    [".js", ".d.ts"],
    [".jsx", ".d.ts"],
    [".mjs", ".d.mts"],
    [".cjs", ".d.cts"],
  ]);

  static fileOf(relativePath: string): string | undefined {
    for (const [
      javaScriptExtension,
      declarationExtension,
    ] of JavaScriptDeclarationTwin.DECLARATION_EXTENSION_BY_JAVASCRIPT_EXTENSION) {
      if (relativePath.endsWith(javaScriptExtension)) {
        return relativePath.slice(0, -javaScriptExtension.length) + declarationExtension;
      }
    }
    return undefined;
  }
}
