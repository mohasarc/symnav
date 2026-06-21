import { PaymentProcessor } from "../payments";

export class RefundService {
  refundAll(amounts: readonly number[]): string[] {
    const processor = new PaymentProcessor();
    return amounts.map((amount) => processor.refund(amount));
  }
}
