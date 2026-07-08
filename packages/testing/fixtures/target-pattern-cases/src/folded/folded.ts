describe("x", () => {
  function insideFold(): string {
    return "inside-fold";
  }

  function callInsideFold(): string {
    return insideFold();
  }

  callInsideFold();
});
