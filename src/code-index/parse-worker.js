const { parentPort } = require('worker_threads'),
  codeParser = require('../../parse-code');

// Parse a batch of files, isolating failures per file: one pathological
// Input must not throw out of the message handler (killing the worker and
// With it every batch in flight across the pool).
function parseFiles(files) {
  const results = [];
  for (const { filePath, content } of files) {
    try {
      results.push({ filePath, symbols: codeParser.parseContent(filePath, content) });
    } catch (e) {
      results.push({ filePath, symbols: [], error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

async function init() {
  try {
    await codeParser.init();
  } catch (e) {
    parentPort.postMessage({ type: 'error', error: e.message });
    return;
  }
  parentPort.postMessage({ type: 'ready' });
}

// ParentPort only exists inside a worker thread; the guard keeps this module
// Require-able from the main thread (tests import parseFiles directly).
if (parentPort) {
  parentPort.on('message', (msg) => {
    if (msg.type === 'parse') {
      parentPort.postMessage({ type: 'results', id: msg.id, results: parseFiles(msg.files) });
    }

    if (msg.type === 'shutdown') {
      process.exit(0);
    }
  });

  init();
}

module.exports = { parseFiles };
