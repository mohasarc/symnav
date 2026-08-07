describe("setup", () => {
  const setupHelper = () => 1;
});

describe("cursor", () => {
  const cursorHelper = () => 2;

  describe("nested", () => {
    const nestedHelper = () => 3;
  });
});

export function action(flag: boolean): void {
  if (flag) {
    const branchValue = 1;
    void branchValue;
  }
}
