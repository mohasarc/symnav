import { getStaticTOMLValue, parseTOML, type AST } from "toml-eslint-parser";

export class TomlDocument {
  private readonly ast: AST.TOMLProgram;
  private readonly values = new Map<string, AST.TOMLContentNode>();
  private readonly tables = new Map<string, AST.TOMLTable>();
  public readonly configuration: Record<string, unknown>;
  public readonly newline: string;

  public constructor(private readonly source: string) {
    this.ast = parseTOML(source);
    this.configuration = getStaticTOMLValue(this.ast) as Record<string, unknown>;
    this.newline = source.includes("\r\n") ? "\r\n" : "\n";
    for (const node of this.ast.body[0].body) {
      if (node.type === "TOMLKeyValue") this.indexValue([], node);
      else {
        const path = node.resolvedKey.map(String);
        this.tables.set(JSON.stringify(path), node);
        for (const property of node.body) this.indexValue(path, property);
      }
    }
  }

  public value(path: readonly string[]): unknown {
    return path.reduce<unknown>(
      (value, key) =>
        typeof value === "object" && value !== null && Object.hasOwn(value, key)
          ? (value as Record<string, unknown>)[key]
          : undefined,
      this.configuration,
    );
  }

  public line(path: readonly string[]): number | undefined {
    return (this.values.get(JSON.stringify(path)) ?? this.tables.get(JSON.stringify(path)))?.loc
      .start.line;
  }

  public set(path: readonly string[], serializedValue: string): string {
    const existing = this.values.get(JSON.stringify(path));
    if (existing !== undefined)
      return this.replace(existing.range[0], existing.range[1], serializedValue);
    for (let length = path.length - 1; length > 0; length -= 1) {
      const ancestor = this.values.get(JSON.stringify(path.slice(0, length)));
      if (ancestor?.type !== "TOMLInlineTable") continue;
      const separator = ancestor.body.length === 0 ? "" : ", ";
      const assignment = `${this.key(path.slice(length))} = ${serializedValue}`;
      return this.replace(
        ancestor.range[1] - 1,
        ancestor.range[1] - 1,
        `${separator}${assignment}`,
      );
    }
    for (let length = path.length - 1; length > 0; length -= 1) {
      const table = this.tables.get(JSON.stringify(path.slice(0, length)));
      if (table === undefined) continue;
      const nextTable = this.ast.body[0].body.find(
        (node) => node.type === "TOMLTable" && node.range[0] > table.range[0],
      );
      const offset = nextTable?.range[0] ?? this.source.length;
      return this.insertLine(offset, `${this.key(path.slice(length))} = ${serializedValue}`);
    }
    const firstTable = this.ast.body[0].body.find((node) => node.type === "TOMLTable");
    return this.insertLine(
      firstTable?.range[0] ?? this.source.length,
      `${this.key(path)} = ${serializedValue}`,
    );
  }

  public appendString(path: readonly string[], value: string): string {
    const array = this.values.get(JSON.stringify(path));
    if (array?.type !== "TOMLArray") throw new Error("expected a TOML array");
    const lastElement = array.elements.at(-1);
    const offset = lastElement?.range[1] ?? array.range[0] + 1;
    return this.replace(
      offset,
      offset,
      `${lastElement === undefined ? "" : ", "}${JSON.stringify(value)}`,
    );
  }

  public appendTable(path: readonly string[], assignments: string): string {
    const prefix = this.source.length === 0 || this.source.endsWith("\n") ? "" : this.newline;
    return `${this.source}${prefix}[${this.key(path)}]${this.newline}${assignments}${this.newline}`;
  }

  private indexValue(parentPath: readonly string[], property: AST.TOMLKeyValue): void {
    const path = [
      ...parentPath,
      ...property.key.keys.map((key) => (key.type === "TOMLBare" ? key.name : key.value)),
    ];
    this.values.set(JSON.stringify(path), property.value);
    if (property.value.type === "TOMLInlineTable") {
      for (const child of property.value.body) this.indexValue(path, child);
    }
  }

  private key(path: readonly string[]): string {
    return path
      .map((part) => (/^[A-Za-z0-9_-]+$/u.test(part) ? part : JSON.stringify(part)))
      .join(".");
  }

  private insertLine(offset: number, assignment: string): string {
    const prefix = offset === 0 || this.source[offset - 1] === "\n" ? "" : this.newline;
    return this.replace(offset, offset, `${prefix}${assignment}${this.newline}`);
  }

  private replace(start: number, end: number, replacement: string): string {
    return this.source.slice(0, start) + replacement + this.source.slice(end);
  }
}
