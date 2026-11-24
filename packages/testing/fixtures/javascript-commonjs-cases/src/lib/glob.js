function glob(pattern) {
  return [pattern];
}

module.exports = glob;

glob.makeRe = function (pattern) {
  return new RegExp(pattern);
};
