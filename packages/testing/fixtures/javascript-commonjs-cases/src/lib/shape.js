class Shape {
  static square(size) {
    return new Shape(size);
  }

  constructor(size) {
    this.size = size;
  }
}

module.exports = Shape;
