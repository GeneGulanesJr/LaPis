const { executeAndCompress, formatTextOutput } = require('../../token-saver/index'),
  { getStats, clearStats } = require('../../token-saver/savings-store'),
  USAGE = {
    run: '<command...> [--raw] [--text] [--remember]',
    'token-saver-stats': '',
    'token-saver-clear': '',
  };

function register(commands, _deps) {
  commands['token-saver-stats'] = () => getStats();

  commands['token-saver-clear'] = () => {
    clearStats();
    return { ok: true, message: 'Token saver stats cleared.' };
  };
}

module.exports = { register, USAGE, executeAndCompress, formatTextOutput };
