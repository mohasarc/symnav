import { PaymentProcessor } from "../../src/payments/PaymentProcessor";

export function checkCharge(): boolean {
  const sut = new PaymentProcessor();
  return sut.charge(5) === "charged 5";
}
