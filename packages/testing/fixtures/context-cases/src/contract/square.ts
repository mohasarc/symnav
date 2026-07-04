import type { Shape } from "./shape.js";

export class Square implements Shape {
  area(): number {
    return 4;
  }
}
