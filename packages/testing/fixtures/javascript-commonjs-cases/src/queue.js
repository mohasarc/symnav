function Queue() {
  this.items = [];
}

Queue.prototype.push = function push(item) {
  this.items.push(item);
};

function makeQueue() {
  const queue = new Queue();
  queue.push(1);
  return queue;
}

module.exports = { Queue, makeQueue };
