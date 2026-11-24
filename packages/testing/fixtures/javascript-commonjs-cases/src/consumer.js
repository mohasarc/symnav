const { gt } = require("./index");
const semver = require("./index");

function pick(a, b) {
  return gt(a, b) ? a : b;
}

function order(a, b) {
  return semver.compare(a, b);
}

module.exports = { pick, order };
