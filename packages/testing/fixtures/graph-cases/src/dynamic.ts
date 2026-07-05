export function dynamicRoot(kind: "alpha" | "beta"): number {
  return dynamicHandlers[kind]();
}

const dynamicHandlers = {
  alpha: dynamicAlpha,
  beta: dynamicBeta,
};

export function dynamicAlpha(): number {
  return alphaLeaf();
}

export function dynamicBeta(): number {
  return betaLeaf();
}

export function alphaLeaf(): number {
  return 10;
}

export function betaLeaf(): number {
  return 20;
}
