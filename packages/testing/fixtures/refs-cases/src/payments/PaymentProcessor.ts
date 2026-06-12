export class PaymentProcessor {
  charge(amount: number): string {
    return `charged ${amount}`;
  }

  refund(amount: number): string {
    return `refunded ${amount}`;
  }
}

export class UnusedAuditLog {
  record(entry: string): string {
    return entry;
  }
}
