export namespace Outer {
  export class Inner {
    run(): void {}

    static factory(): Inner {
      return new Inner();
    }
  }

  export function helper(x: number): number {
    return x + 1;
  }
}

export interface Order {
  id: string;
  total: number;
  items(): readonly string[];
}

export enum Status {
  Pending,
  Shipped,
  Delivered,
}
