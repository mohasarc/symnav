export abstract class Shape {
  abstract area(): number;
}

export class Box extends Shape {
  static readonly SIDES = 6;

  width: number;
  height: number;

  constructor(width: number, height: number) {
    super();
    this.width = width;
    this.height = height;
  }

  get perimeter(): number {
    return 2 * (this.width + this.height);
  }

  set dimensions(value: { width: number; height: number }) {
    this.width = value.width;
    this.height = value.height;
  }

  area(): number {
    return this.width * this.height;
  }

  static unit(): Box {
    return new Box(1, 1);
  }
}
