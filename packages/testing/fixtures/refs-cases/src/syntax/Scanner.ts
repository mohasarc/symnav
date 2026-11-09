import { Token } from "./Token";

export const firstToken = Token.UsingKeyword;

export function describeToken(token: Token): string {
  switch (token) {
    case Token.UsingKeyword:
      return "using";
    default:
      return token === Token.UsingKeyword ? "using" : "other";
  }
}
