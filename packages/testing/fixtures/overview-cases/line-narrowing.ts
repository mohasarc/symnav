describe("repeated", () => {
  const firstHelper = () => {
    const firstNested = 1;
    return firstNested;
  };
});

describe("repeated", () => {
  const secondHelper = () => 2;
});

describe("inline", () => {}); describe("inline", () => { const inlineHelper = () => 3; void inlineHelper; });

export function host(flag: boolean): void {
  if (flag) {
    const nestedSymbol = () => {
      const nestedValue = 3;
      return nestedValue;
    };
    nestedSymbol();
  }
}
