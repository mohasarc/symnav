import { Node, type EnumMember } from "ts-morph";

export function enumMemberName(member: EnumMember): string {
  const nameNode = member.getNameNode();
  if (Node.isStringLiteral(nameNode)) return nameNode.getLiteralText();
  if (Node.isComputedPropertyName(nameNode)) {
    const expression = nameNode.getExpression();
    if (Node.isStringLiteral(expression)) return expression.getLiteralText();
  }
  return member.getName();
}
