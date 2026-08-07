export function charge(amount: number): string {
  return `adapter:${amount}`;
}
