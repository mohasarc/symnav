export class PaymentProcessor {
  static async charge(orderId: string): Promise<string> {
    return `paid:${orderId}`;
  }
}
