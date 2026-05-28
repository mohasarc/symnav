export type PaymentStatus = "pending" | "paid" | "failed";

export enum PaymentMethod {
  Card = "card",
  Bank = "bank",
}

export interface Payment {
  readonly id: string;
  readonly amount: number;
}
