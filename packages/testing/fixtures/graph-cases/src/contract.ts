export interface GraphShape {
  render(): number;
}

export class Box implements GraphShape {
  render(): number {
    return 1;
  }
}

export class Circle implements GraphShape {
  render(): number {
    return 2;
  }
}
