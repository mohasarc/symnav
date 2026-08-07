import { charge as adapterCharge } from "./adapters/orders";
import { PaymentProcessor as InvoicePaymentProcessor } from "./domain/invoices";
import { PaymentProcessor as OrderPaymentProcessor } from "./domain/orders";
import { helper } from "./unique/helper";

export function useOrderCharge(): string {
  const processor = new OrderPaymentProcessor();
  return processor.charge(10);
}

export function useInvoiceCharge(): string {
  const processor = new InvoicePaymentProcessor();
  return processor.charge(20);
}

export function useAdapterCharge(): string {
  return adapterCharge(30);
}

export function useUniqueHelper(): string {
  return helper();
}

export function useRefund(): string {
  const processor = new OrderPaymentProcessor();
  return processor.refund(5);
}
