import type { PaymentProvider } from "./PaymentProvider.js";

export class PaypalProvider implements PaymentProvider {
  async charge(orderId: string): Promise<string> {
    return `paypal:${orderId}`;
  }
}
