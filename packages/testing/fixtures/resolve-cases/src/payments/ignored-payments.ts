export const PAYMENT_SECRET = "do-not-leak";

export class PaymentLeak {
  leak(): string {
    return PAYMENT_SECRET;
  }
}
