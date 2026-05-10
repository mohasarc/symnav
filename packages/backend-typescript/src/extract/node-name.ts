import { Node } from "ts-morph";

export function nodeName(node: Node): string {
  if (Node.isConstructorDeclaration(node)) return "constructor";
  if (Node.isCallSignatureDeclaration(node)) return "()";
  if (Node.isConstructSignatureDeclaration(node)) return "new()";
  if (Node.isIndexSignatureDeclaration(node)) return "[index]";
  if (Node.isExportAssignment(node)) return "default";

  if ("getName" in node && typeof (node as { getName?: unknown }).getName === "function") {
    const name = (node as { getName: () => string | undefined }).getName();
    if (name) return name;
  }

  return "";
}
