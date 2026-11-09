export enum Token {
  ["a-b"] = 7,
}

export function isDashed(token: Token): boolean {
  return token === Token["a-b"];
}
