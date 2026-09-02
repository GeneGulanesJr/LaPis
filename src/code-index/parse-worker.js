const { parentPort } = require('worker_threads'),
  codeParser = require('../../parse-code');

async function init() {
  try {
    await codeParser.init();
  } catch (e) {
    parentPort.postMessage({ type: 'error', error: e.message });
    return;
  }
  parentPort.postMessage({ type: 'ready' });
}

parentPort.on('message', (msg) => {
  if (msg.type === 'parse') {
    const results = [];
    for (const { filePath, content } of msg.files) {
      const symbols = codeParser.parseContent(filePath, content);
      results.push({ filePath, symbols });
    }
    parentPort.postMessage({ type: 'results', id: msg.id, results });
  }

  if (msg.type === 'shutdown') {
    process.exit(0);
  }
});

init();
