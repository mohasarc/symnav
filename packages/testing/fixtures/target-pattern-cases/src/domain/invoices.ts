export class PaymentProcessor {
  refund(amount: number): string {
    return `invoice-refund:${amount}`;
  }

  charge(
    amount: number,
    currency?: string,
    idempotencyKey?: string,
    metadata?: Record<string, string>,
  ): string {
    void currency;
    void idempotencyKey;
    void metadata;
    return `invoice:${amount}`;
  }
}
