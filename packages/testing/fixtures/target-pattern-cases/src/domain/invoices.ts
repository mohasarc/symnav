export class PaymentProcessor {
  charge(amount: number): string {
    return `invoice:${amount}`;
  }
}
