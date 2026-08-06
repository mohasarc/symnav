export class HiddenProcessor {
  charge(amount: number): string {
    return `hidden:${amount}`;
  }
}
