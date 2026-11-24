exports.parse = function (text) {
  return text.split(",");
};

module.exports.format = function (parts) {
  return parts.join(",");
};
