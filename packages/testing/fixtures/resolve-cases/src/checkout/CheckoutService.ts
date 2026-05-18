export const MAX_PAYMENT_RETRIES = 3;

export interface Payment {
  readonly orderId: string;
}

export class CheckoutService {
  async processPayment(orderId: string): Promise<string> {
    return `processed:${orderId}`;
  }
}
