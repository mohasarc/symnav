import type { PaymentProvider } from "./PaymentProvider.js";

export class StripeProvider implements PaymentProvider {
  async charge(orderId: string): Promise<string> {
    return `stripe:${orderId}`;
  }
}
