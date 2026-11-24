import { ts } from "ts-morph";

const BYTE_ORDER_MARK = "﻿";
const FLOW_PRAGMA = /(?<![^\s*/])@(?:no)?flow(?![^\s*/])/;

export class FlowPragmaDetector {
  static hasFlowPragma(text: string): boolean {
    const source = text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
    const leadingComments = ts.getLeadingCommentRanges(source, 0) ?? [];
    return leadingComments.some((comment) =>
      FLOW_PRAGMA.test(source.slice(comment.pos, comment.end)),
    );
  }
}
