import type { Node, ts } from "ts-morph";

export class NodeLineNumbers {
  private static readonly LINE_FEED = "\n";
  private static readonly FIRST_LINE = 1;

  private static readonly lineFeedPositionsBySourceFile = new WeakMap<
    ts.SourceFile,
    readonly number[]
  >();

  static startLine(node: Node): number {
    return NodeLineNumbers.lineAt(node.getSourceFile().compilerNode, node.getStart());
  }

  static endLine(node: Node): number {
    return NodeLineNumbers.lineAt(node.getSourceFile().compilerNode, node.getEnd());
  }

  private static lineAt(sourceFile: ts.SourceFile, position: number): number {
    const lineFeeds = NodeLineNumbers.lineFeedPositions(sourceFile);
    let low = 0;
    let high = lineFeeds.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((lineFeeds[middle] as number) < position) low = middle + 1;
      else high = middle;
    }
    return low + NodeLineNumbers.FIRST_LINE;
  }

  private static lineFeedPositions(sourceFile: ts.SourceFile): readonly number[] {
    const cached = NodeLineNumbers.lineFeedPositionsBySourceFile.get(sourceFile);
    if (cached) return cached;
    const text = sourceFile.text;
    const positions: number[] = [];
    for (
      let position = text.indexOf(NodeLineNumbers.LINE_FEED);
      position >= 0;
      position = text.indexOf(NodeLineNumbers.LINE_FEED, position + 1)
    ) {
      positions.push(position);
    }
    NodeLineNumbers.lineFeedPositionsBySourceFile.set(sourceFile, positions);
    return positions;
  }
}
