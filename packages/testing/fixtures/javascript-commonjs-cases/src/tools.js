const { makeRe } = require("./lib/glob");
const { version } = require("./lib/defined");

function split(text) {
  return require("./lib/alias").splitList(text);
}

function compile(pattern) {
  return makeRe(pattern);
}

function release() {
  return version();
}

module.exports = { split, compile, release };
