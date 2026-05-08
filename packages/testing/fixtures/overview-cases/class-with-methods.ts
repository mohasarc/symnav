export class CheckoutService {
  private retries: number = 0;

  constructor(initial: number) {
    this.retries = initial;
  }

  get count(): number {
    return this.retries;
  }

  set count(value: number) {
    this.retries = value;
  }

  process(order: string): string {
    return order;
  }

  static make(): CheckoutService {
    return new CheckoutService(0);
  }
}
