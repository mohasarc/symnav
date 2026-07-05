export function chainRoot(): number {
  return chainOne();
}

export function chainOne(): number {
  return chainTwo();
}

export function chainTwo(): number {
  return chainThree();
}

export function chainThree(): number {
  return chainFour();
}

export function chainFour(): number {
  return chainFive();
}

export function chainFive(): number {
  return chainSix();
}

export function chainSix(): number {
  return 6;
}
