export interface PaymentProvider {
  charge(orderId: string): Promise<string>;
}
