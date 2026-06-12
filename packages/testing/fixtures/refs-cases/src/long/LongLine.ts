import { PaymentProcessor } from "../payments/PaymentProcessor";

export const earlyProcessor = { processor: new PaymentProcessor(), label: "a deliberately long label that pushes this source line well past the preview width" };

export const lateProcessor = { label: "another deliberately long label that pushes this source line well past the preview width", processor: new PaymentProcessor() };
