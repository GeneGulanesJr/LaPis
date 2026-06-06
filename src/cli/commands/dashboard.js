'use strict';

const { getDashboard } = require('../../../data-access/dashboard');

const USAGE = {};

function register(commands, deps) {
  commands.dashboard = () => getDashboard(deps);
}

module.exports = { register, USAGE };
