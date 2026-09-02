'use strict';

const { getDashboard } = require('../../../data-access/dashboard'),
  USAGE = {};

function register(commands, deps) {
  commands.dashboard = () => getDashboard(deps);
}

module.exports = { register, USAGE };
