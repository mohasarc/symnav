const { first } = require("./lib/umd");
const { square } = require("./lib/shape");
const { label } = require("./lib/setup");

function pickFirst(items) {
  return first(items);
}

function makeSquare() {
  return square(2);
}

function readLabel() {
  return label();
}

module.exports = { pickFirst, makeSquare, readLabel };
