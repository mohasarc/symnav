export abstract class Shape {
  abstract area(): number;
}

export class Circle extends Shape {
  constructor(private readonly radius: number) {
    super();
  }
  area(): number {
    return Math.PI * this.radius * this.radius;
  }
}

export class Square extends Shape {
  constructor(private readonly side: number) {
    super();
  }
  area(): number {
    return this.side * this.side;
  }
}
