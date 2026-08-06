declare function describe(name: string, body: () => void): void;

describe("x", () => {
  function insideFold(): string {
    return "inside-fold";
  }

  function callInsideFold(): string {
    return insideFold();
  }

  callInsideFold();
});
