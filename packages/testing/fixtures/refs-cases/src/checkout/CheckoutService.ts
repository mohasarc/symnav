import { PaymentProcessor } from "../payments/PaymentProcessor";

export class CheckoutService {
  private readonly processor: PaymentProcessor;

  constructor() {
    this.processor = new PaymentProcessor();
  }

  checkout(amount: number): string {
    return this.processor.charge(amount);
  }
}
