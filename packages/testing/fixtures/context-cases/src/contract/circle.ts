import type { Shape } from "./shape.js";

export class Circle implements Shape {
  area(): number {
    return 3.14;
  }
}
