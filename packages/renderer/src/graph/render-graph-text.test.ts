import { describe, expect, it } from "vitest";

import { decl, path, result, step } from "./graph-renderer-test-helpers.js";
import { renderGraphText } from "./render-graph-text.js";

const root = decl({
  file: "src/checkout/CheckoutService.ts",
  segments: [{ name: "CheckoutService" }, { name: "processPayment" }],
  startLine: 42,
  endLine: 78,
  signature: ["async processPayment(order: Order): Promise<Receipt>"],
});

describe("renderGraphText", () => {
  it("renders the full spec depth-two example shape", () => {
    const controller = decl({
      file: "src/api/CheckoutController.ts",
      segments: [{ name: "CheckoutController" }, { name: "submitOrder" }],
      startLine: 58,
      endLine: 72,
      signature: ["submitOrder(req: Request): Promise<Response>"],
    });
    const routes = decl({
      file: "src/api/routes.ts",
      segments: [{ name: "registerCheckoutRoutes" }],
      startLine: 14,
      endLine: 20,
      signature: ["function registerCheckoutRoutes(router: Router): void"],
    });
    const charge = decl({
      file: "src/payments/PaymentProcessor.ts",
      segments: [{ name: "PaymentProcessor" }, { name: "charge" }],
      startLine: 22,
      endLine: 36,
      signature: ["static async charge(order: Order): Promise<Payment>"],
    });
    const capture = decl({
      file: "src/payments/GatewayClient.ts",
      segments: [{ name: "GatewayClient" }, { name: "capture" }],
      startLine: 31,
      endLine: 46,
      signature: ["capture(payment: Payment): Promise<CaptureResult>"],
    });
    const markPaid = decl({
      file: "src/orders/OrderRepository.ts",
      segments: [{ name: "OrderRepository" }, { name: "markPaid" }],
      startLine: 65,
      endLine: 81,
      signature: ["markPaid(orderId: string): Promise<void>"],
    });
    const transaction = decl({
      file: "src/database/Database.ts",
      segments: [{ name: "Database" }, { name: "transaction" }],
      startLine: 18,
      endLine: 34,
      signature: ["transaction<T>(callback: TransactionCallback<T>): Promise<T>"],
    });

    const graph = result(root, {
      incoming: { paths: [path(step(controller), step(routes))], totalPathCount: 1 },
      outgoing: {
        paths: [path(step(charge), step(capture)), path(step(markPaid), step(transaction))],
        totalPathCount: 2,
      },
    });

    expect(renderGraphText(graph)).toBe(
      [
        "Graph: CheckoutService::processPayment",
        "File: src/checkout/CheckoutService.ts",
        "Lines: 42-78",
        "Depth: 2",
        "Direction: both",
        "Edges: calls",
        "",
        "Incoming",
        "src/checkout/CheckoutService.ts",
        "└── 42-78: CheckoutService::processPayment",
        "    async processPayment(order: Order): Promise<Receipt>",
        "    └── src/api/CheckoutController.ts",
        "        └── 58-72: CheckoutController::submitOrder  [caller]",
        "            submitOrder(req: Request): Promise<Response>",
        "            └── src/api/routes.ts",
        "                └── 14-20: registerCheckoutRoutes  [caller]",
        "                    function registerCheckoutRoutes(router: Router): void",
        "",
        "Outgoing",
        "src/checkout/CheckoutService.ts",
        "└── 42-78: CheckoutService::processPayment",
        "    async processPayment(order: Order): Promise<Receipt>",
        "    ├── src/payments/PaymentProcessor.ts",
        "    │   └── 22-36: PaymentProcessor::charge  [callee]",
        "    │       static async charge(order: Order): Promise<Payment>",
        "    │       └── src/payments/GatewayClient.ts",
        "    │           └── 31-46: GatewayClient::capture  [callee]",
        "    │               capture(payment: Payment): Promise<CaptureResult>",
        "    └── src/orders/OrderRepository.ts",
        "        └── 65-81: OrderRepository::markPaid  [callee]",
        "            markPaid(orderId: string): Promise<void>",
        "            └── src/database/Database.ts",
        "                └── 18-34: Database::transaction  [callee]",
        "                    transaction<T>(callback: TransactionCallback<T>): Promise<T>",
        "",
      ].join("\n"),
    );
  });

  it("renders possible and cycle tags", () => {
    const possible = decl({
      file: "src/routing/DynamicRouter.ts",
      segments: [{ name: "DynamicRouter" }, { name: "dispatch" }],
      startLine: 44,
      endLine: 58,
      signature: ["dispatch(action: string): Promise<void>"],
    });
    const cycle = decl({
      file: "src/checkout/CheckoutService.ts",
      segments: [{ name: "CheckoutService" }, { name: "processPayment" }],
      startLine: 42,
      endLine: 78,
      signature: ["async processPayment(order: Order): Promise<Receipt>"],
    });
    const graph = result(root, {
      incoming: undefined,
      direction: "outgoing",
      outgoing: {
        paths: [
          path(
            step(possible, { confidence: "possible", reason: "dynamic property access" }),
            step(cycle, { closesCycle: true }),
          ),
        ],
        totalPathCount: 1,
      },
    });

    const text = renderGraphText(graph);
    expect(text).toContain("DynamicRouter::dispatch  [possible: dynamic property access]");
    expect(text).toContain("CheckoutService::processPayment  [callee]  [cycle]");
  });

  it("shares one file-path line for same-file siblings", () => {
    const charge = decl({
      file: "src/payments/PaymentProcessor.ts",
      segments: [{ name: "PaymentProcessor" }, { name: "charge" }],
      startLine: 22,
      endLine: 36,
      signature: ["charge(): void"],
    });
    const refund = decl({
      file: "src/payments/PaymentProcessor.ts",
      segments: [{ name: "PaymentProcessor" }, { name: "refund" }],
      startLine: 40,
      endLine: 45,
      signature: ["refund(): void"],
    });
    const graph = result(root, {
      incoming: undefined,
      direction: "outgoing",
      outgoing: { paths: [path(step(charge)), path(step(refund))], totalPathCount: 2 },
    });

    expect(renderGraphText(graph)).toContain(
      [
        "    └── src/payments/PaymentProcessor.ts",
        "        ├── 22-36: PaymentProcessor::charge  [callee]",
        "        │   charge(): void",
        "        └── 40-45: PaymentProcessor::refund  [callee]",
        "            refund(): void",
      ].join("\n"),
    );
  });

  it("renders an empty included direction as a root-only tree", () => {
    const graph = result(root, {
      direction: "incoming",
      outgoing: undefined,
      incoming: { paths: [], totalPathCount: 0 },
    });

    expect(renderGraphText(graph)).toBe(
      [
        "Graph: CheckoutService::processPayment",
        "File: src/checkout/CheckoutService.ts",
        "Lines: 42-78",
        "Depth: 2",
        "Direction: incoming",
        "Edges: calls",
        "",
        "Incoming",
        "src/checkout/CheckoutService.ts",
        "└── 42-78: CheckoutService::processPayment",
        "    async processPayment(order: Order): Promise<Receipt>",
        "",
      ].join("\n"),
    );
  });

  it("renders only the requested direction", () => {
    const graph = result(root, { direction: "outgoing", incoming: undefined });
    const text = renderGraphText(graph);

    expect(text).not.toContain("Incoming");
    expect(text).toContain("Outgoing");
  });

  it("adds page metadata only for multi-page results", () => {
    const onePageText = renderGraphText(result(root, { page: 1, pageCount: 1 }));
    const multiPageText = renderGraphText(result(root, { page: 2, pageCount: 3 }));

    expect(onePageText).not.toContain("Page:");
    expect(multiPageText).toContain("Edges: calls\nPage: 2/3");
  });

  it("adds singular and plural repeated symbol notes", () => {
    expect(renderGraphText(result(root, { repeatedSymbolCount: 1 }))).toContain(
      "Note: 1 symbol appears in multiple paths.",
    );
    expect(renderGraphText(result(root, { repeatedSymbolCount: 3 }))).toContain(
      "Note: 3 symbols appear in multiple paths.",
    );
    expect(renderGraphText(result(root, { repeatedSymbolCount: 0 }))).not.toContain("Note:");
  });
});
