export function cycleA(): number {
  return cycleB();
}

export function cycleB(): number {
  return cycleC();
}

export function cycleC(): number {
  return cycleA();
}
