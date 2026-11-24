function setup() {
  return 0;
}

function realLabel() {
  return "real";
}

function localLabel() {
  return "local";
}

function install(setup) {
  setup.label = localLabel;
}

module.exports = setup;
setup.label = realLabel;
install({});
