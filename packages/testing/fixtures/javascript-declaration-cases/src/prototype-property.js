function Queue() {
  this.items = [];
}

Queue.prototype.push = function (item) {
  this.items.push(item);
};
