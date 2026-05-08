export namespace Outer {
  export class Inner {
    method(): void {
      return;
    }
  }
}

export interface Shape {
  area(): number;
  name: string;
}

export enum Color {
  Red,
  Green,
  Blue,
}
