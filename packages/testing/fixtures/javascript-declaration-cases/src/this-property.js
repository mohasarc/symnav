class Counter {
  constructor() {
    this.count = 0;
  }

  increment() {
    this.count = this.count + 1;
    this.label = `count ${this.count}`;
  }
}
