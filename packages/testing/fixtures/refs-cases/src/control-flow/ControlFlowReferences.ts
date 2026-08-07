import { controlFlowTarget } from "./ControlFlowTarget";

export function callThroughControlFlow(items: readonly string[], enabled: boolean): void {
  if (enabled) {
    controlFlowTarget();
  }

  for (const item of items) {
    if (item) {
      controlFlowTarget();
    }
  }

  while (enabled) {
    controlFlowTarget();
    break;
  }

  items.forEach((item) => {
    if (item.length > 0) {
      controlFlowTarget();
    }
  });
}
