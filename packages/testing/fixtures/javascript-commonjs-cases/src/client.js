const { parse } = require("./lib/strings");
const { trim, pad } = require("./lib/padding");
const format = require("./lib/strings").format;
const all = require("./lib/all");
const { now } = require("./lib/clock");

function readList(text) {
  return parse(trim(text));
}

function writeList(parts) {
  return pad(format(parts));
}

function roundTrip(text) {
  return all.format(all.parse(text));
}

function stamp() {
  return now();
}

module.exports = { readList, writeList, roundTrip, stamp };
