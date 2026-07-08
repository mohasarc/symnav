export class PaymentProcessor {
  charge(amount: number): string {
    const formatCharge = () => `order:${amount}`;
    return formatCharge();
  }

  refund(amount: number): string {
    return `refund:${amount}`;
  }

  audit(): string {
    if (Date.now() > 0) {
      function orderChargeHelper(): string {
        return "audit";
      }

      return orderChargeHelper();
    }

    return "skipped";
  }
}
