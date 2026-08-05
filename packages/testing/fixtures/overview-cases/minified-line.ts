declare function describe(name: string, body: () => void): void;

describe("alpha", () => {}); describe("beta", () => { const betaHelper = () => 1; void betaHelper; }); describe("gamma", () => {});
