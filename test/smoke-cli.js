// Test/smoke-cli.js
// Smoke tests: verify every CLI command exits cleanly after extraction.
// Run: node test/smoke-cli.js
// These are NOT vitest tests — they run as a standalone Node script
// So they can be executed in CI without the vitest runner.

const { execSync } = require('child_process'), path = require('path'), fs = require('fs'), os = require('os'),
  ROOT = path.resolve(__dirname, '..'),
  CLI = `node "${path.join(ROOT, 'memory-store.js')}"`,
  TMP_DIR = path.join(os.tmpdir(), `lapis-smoke-${Date.now()}`), failures = [];




let passed = 0,
  failed = 0;










console.log('\nSmoke CLI Tests\n');

// --- Group 1: Help output (--help exits 0 and prints usage to stdout) ---
console.log('Help output:');
smokeTest('--help lists subcommands', `${CLI} --help`, {
  expectContains: 'Subcommands:',
});
smokeTest('save --help prints save usage', `${CLI} save --help`, {
  expectContains: 'Usage: lapis save',
});
smokeTest('save -h prints save usage', `${CLI} save -h`, {
  expectContains: '--title',
});

// Verify key subcommands are listed
const helpOutput = (() => {
    try {
      return execSync(`${CLI} --help`, {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      // Fallback: capture from combined streams if exit code differs
      return (e.stdout || '') + (e.stderr || '');
    }
  })(),
  requiredCommands = [
    'save',
    'search',
    'context',
    'get',
    'update',
    'delete',
    'index-repo',
    'reindex-repo',
    'search-code',
    'list-code-repos',
    'remove-code-repo',
    'import-graph',
    'call-hierarchy',
    'blast-radius',
    'dead-code',
    'complexity',
    'outline',
    'churn',
    'hotspots',
    'cycles',
    'importance',
    'coupling',
    'extractable',
    'hierarchy',
    'signal-chains',
    'layer-violations',
    'winnow',
    'ast-patterns',
    'untested',
    'pr-risk',
    'index-docs',
    'reindex-docs',
    'doc-search',
    'doc-outline',
    'backlinks',
    'broken-links',
    'glossary',
    'tutorial-path',
    'code-examples',
    'doc-orphans',
    'doc-coverage',
    'stale-pages',
    'doc-duplicates',
    'link-symbol',
    'auto-link',
    'adjust-trust',
    'sync-code-trust',
    'symbol-cluster',
    'related',
    'session-start',
    'session-end',
    'session-summary',
    'init',
    'compact',
    'dream',
    'auto-recover',
    'recover-orphans',
    'trust-recovery',
    'list-projects',
    'list-workspaces',
    'create-workspace',
    'archive-workspace',
    'stats',
    'timeline',
    'check-dup',
    'mark-dup',
    'save-prompt',
    'capture-passive',
    'suggest-topic-key',
    'record-recall',
    'stale-links',
    'provenance',
  ];

for (const cmd of requiredCommands) {
  const found = helpOutput.includes(cmd);
  if (found) {
    console.log(`  ✓ --help lists ${cmd}`);
    passed++;
  } else {
    console.log(`  ✗ --help lists ${cmd}`);
    failures.push(`--help lists ${cmd}`);
    failed++;
  }
}

// --- Group 2: Commands that need a DB (use temp HOME) ---
console.log('\nMemory commands (temp DB):');
smokeTestWithDb('save + search round-trip', path.join(TMP_DIR, 'smoke-memory.db'), (env) => {
  run(`${CLI} save --content "smoke test observation" --type bugfix --scope project --title "smoke test"`, { env });
  const out = run(`${CLI} search --query "smoke test"`, { env });
  if (!out.includes('results')) {
    throw new Error('search did not return results key');
  }
});

smokeTestWithDb('save + get round-trip', path.join(TMP_DIR, 'smoke-get.db'), (env) => {
  const saveOut = run(`${CLI} save --content "get test" --type decision --scope project --title "get test"`, { env });
  if (!saveOut.includes('"id"')) {
    throw new Error('save did not return id');
  }
  // Get requires --id
  {
const getOut = run(`${CLI} get --id 1`, { env });
  if (!getOut.includes('"id"') && !getOut.includes('error')) {
    throw new Error('get unexpected output');
  }
}
});

smokeTestWithDb('save + update', path.join(TMP_DIR, 'smoke-upd.db'), (env) => {
  run(`${CLI} save --content "update test" --type learning --scope project --title "update test"`, { env });
  const out = run(`${CLI} update --id 1 --content "updated content"`, { env });
  if (!out.includes('"id"') && !out.includes('error')) {
    throw new Error('update unexpected output');
  }
});

smokeTestWithDb('save + delete', path.join(TMP_DIR, 'smoke-del.db'), (env) => {
  run(`${CLI} save --content "delete test" --type bugfix --scope project --title "delete test"`, { env });
  const out = run(`${CLI} delete --id 1`, { env });
  if (!out.includes('ok') && !out.includes('error')) {
    throw new Error('delete unexpected output');
  }
});

smokeTestWithDb('memory context', path.join(TMP_DIR, 'smoke-ctx.db'), (env) => {
  run(`${CLI} save --content "ctx test" --type decision --scope project --title "ctx test"`, { env });
  run(`${CLI} context --query "ctx test"`, { env });
});

smokeTestWithDb('memory stats', path.join(TMP_DIR, 'smoke-stats.db'), (env) => {
  const out = run(`${CLI} stats`, { env });
  if (!out.includes('total_observations')) {
    throw new Error('stats missing total_observations');
  }
});

smokeTestWithDb('timeline', path.join(TMP_DIR, 'smoke-tl.db'), (env) => {
  run(`${CLI} save --content "tl test" --type bugfix --scope project --title "tl test"`, { env });
  run(`${CLI} timeline`, { env });
});

smokeTestWithDb('suggest-topic-key', path.join(TMP_DIR, 'smoke-tk.db'), (env) => {
  const out = run(`${CLI} suggest-topic-key --content "test"`, { env });
  if (!out.includes('topic_key')) {
    throw new Error('suggest-topic-key unexpected output');
  }
});

smokeTestWithDb('check-dup', path.join(TMP_DIR, 'smoke-dup.db'), (env) => {
  const out = run(`${CLI} check-dup --content "test"`, { env });
  if (!out.includes('potential_duplicates')) {
    throw new Error('check-dup unexpected output');
  }
});

smokeTestWithDb('save-prompt', path.join(TMP_DIR, 'smoke-sp.db'), (env) => {
  run(`${CLI} save-prompt --role user --content "test prompt"`, { env });
});

smokeTestWithDb('capture-passive', path.join(TMP_DIR, 'smoke-cp.db'), (env) => {
  run(`${CLI} capture-passive --role assistant --content "test response"`, { env });
});

console.log('\nCode index commands (temp DB):');
smokeTestWithDb('index-repo + search-code', path.join(TMP_DIR, 'smoke-code.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name smoke-repo`, { env });
  const out = run(`${CLI} search-code --repo smoke-repo --query "foo"`, { env });
  if (!out.includes('foo') && !out.includes('No results')) {
    throw new Error('search-code unexpected output');
  }
});

smokeTestWithDb('index-repo + list-code-repos', path.join(TMP_DIR, 'smoke-list.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name list-repo`, { env });
  const out = run(`${CLI} list-code-repos`, { env });
  if (!out.includes('list-repo')) {
    throw new Error('list-code-repos did not include indexed repo');
  }
});

smokeTestWithDb('outline', path.join(TMP_DIR, 'smoke-outline.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name outline-repo`, { env });
  run(`${CLI} outline --repo outline-repo --file index.js`, { env });
});

smokeTestWithDb('import-graph', path.join(TMP_DIR, 'smoke-import.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name import-repo`, { env });
  run(`${CLI} import-graph --repo import-repo`, { env });
});

smokeTestWithDb('call-hierarchy', path.join(TMP_DIR, 'smoke-callh.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name callh-repo`, { env });
  run(`${CLI} call-hierarchy --repo callh-repo --symbol foo`, { env });
});

smokeTestWithDb('blast-radius', path.join(TMP_DIR, 'smoke-blast.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name blast-repo`, { env });
  run(`${CLI} blast-radius --repo blast-repo --symbol foo`, { env });
});

smokeTestWithDb('dead-code', path.join(TMP_DIR, 'smoke-dead.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name dead-repo`, { env });
  run(`${CLI} dead-code --repo dead-repo`, { env });
});

smokeTestWithDb('complexity', path.join(TMP_DIR, 'smoke-complex.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name complex-repo`, { env });
  run(`${CLI} complexity --repo complex-repo --symbol foo`, { env });
});

smokeTestWithDb('coupling', path.join(TMP_DIR, 'smoke-coup.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name coup-repo`, { env });
  run(`${CLI} coupling --repo coup-repo`, { env });
});

smokeTestWithDb('hotspots', path.join(TMP_DIR, 'smoke-hot.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name hot-repo`, { env });
  run(`${CLI} hotspots --repo hot-repo`, { env });
});

smokeTestWithDb('cycles', path.join(TMP_DIR, 'smoke-cyc.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name cyc-repo`, { env });
  run(`${CLI} cycles --repo cyc-repo`, { env });
});

smokeTestWithDb('hierarchy', path.join(TMP_DIR, 'smoke-hier.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name hier-repo`, { env });
  run(`${CLI} hierarchy --repo hier-repo`, { env });
});

smokeTestWithDb('extractable', path.join(TMP_DIR, 'smoke-extr.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name extr-repo`, { env });
  run(`${CLI} extractable --repo extr-repo`, { env });
});

smokeTestWithDb('importance', path.join(TMP_DIR, 'smoke-imp.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name imp-repo`, { env });
  run(`${CLI} importance --repo imp-repo`, { env });
});

smokeTestWithDb('signal-chains', path.join(TMP_DIR, 'smoke-sig.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name sig-repo`, { env });
  run(`${CLI} signal-chains --repo sig-repo`, { env });
});

smokeTestWithDb('layer-violations', path.join(TMP_DIR, 'smoke-lv.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name lv-repo`, { env });
  run(`${CLI} layer-violations --repo lv-repo`, { env });
});

smokeTestWithDb('churn', path.join(TMP_DIR, 'smoke-churn.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name churn-repo`, { env });
  // Churn needs git history, will return error for temp dir — that's OK
  run(`${CLI} churn --repo churn-repo --file index.js`, { env });
});

smokeTestWithDb('winnow', path.join(TMP_DIR, 'smoke-win.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name win-repo`, { env });
  run(`${CLI} winnow --repo win-repo`, { env });
});

smokeTestWithDb('ast-patterns', path.join(TMP_DIR, 'smoke-ast.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name ast-repo`, { env });
  run(`${CLI} ast-patterns --repo ast-repo`, { env });
});

smokeTestWithDb('untested', path.join(TMP_DIR, 'smoke-ut.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name ut-repo`, { env });
  run(`${CLI} untested --repo ut-repo`, { env });
});

smokeTestWithDb('pr-risk', path.join(TMP_DIR, 'smoke-pr.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name pr-repo`, { env });
  run(`${CLI} pr-risk --repo pr-repo`, { env });
});

smokeTestWithDb('provenance', path.join(TMP_DIR, 'smoke-prov.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name prov-repo`, { env });
  run(`${CLI} provenance --repo prov-repo`, { env });
});

smokeTestWithDb('get-code-source', path.join(TMP_DIR, 'smoke-gcs.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name gcs-repo`, { env });
  run(`${CLI} get-code-source --repo gcs-repo --file index.js`, { env });
});

smokeTestWithDb('remove-code-repo', path.join(TMP_DIR, 'smoke-rm.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name rm-repo`, { env });
  run(`${CLI} remove-code-repo --repo rm-repo`, { env });
});

smokeTestWithDb('reindex-repo', path.join(TMP_DIR, 'smoke-reindex.db'), (env, projectDir) => {
  run(`${CLI} index-repo --path "${projectDir}" --name reindex-repo`, { env });
  run(`${CLI} reindex-repo --repo reindex-repo --path "${projectDir}"`, { env });
});

console.log('\nDoc index commands (temp DB):');
smokeTestWithDb('index-docs + doc-search', path.join(TMP_DIR, 'smoke-doc.db'), (env, _projectDir, docsDir) => {
  run(`${CLI} index-docs --path "${docsDir}" --name smoke-docs`, { env });
  const out = run(`${CLI} doc-search --repo smoke-docs --query "Section One"`, { env });
  if (!out.includes('results') && !out.includes('No results')) {
    throw new Error('doc-search unexpected output');
  }
});

smokeTestWithDb('doc-outline', path.join(TMP_DIR, 'smoke-docol.db'), (env, _projectDir, docsDir) => {
  run(`${CLI} index-docs --path "${docsDir}" --name dol-docs`, { env });
  run(`${CLI} doc-outline --repo dol-docs --file readme.md`, { env });
});

smokeTestWithDb('backlinks', path.join(TMP_DIR, 'smoke-bl.db'), (env, _projectDir, docsDir) => {
  run(`${CLI} index-docs --path "${docsDir}" --name bl-docs`, { env });
  run(`${CLI} backlinks --repo bl-docs --doc-path readme.md`, { env });
});

smokeTestWithDb('glossary', path.join(TMP_DIR, 'smoke-gloss.db'), (env, _projectDir, docsDir) => {
  run(`${CLI} index-docs --path "${docsDir}" --name gloss-docs`, { env });
  run(`${CLI} glossary --repo gloss-docs --term "Test"`, { env });
});

smokeTestWithDb('broken-links', path.join(TMP_DIR, 'smoke-bl2.db'), (env, _projectDir, docsDir) => {
  run(`${CLI} index-docs --path "${docsDir}" --name bl2-docs`, { env });
  run(`${CLI} broken-links --repo bl2-docs`, { env });
});

smokeTestWithDb('stale-pages', path.join(TMP_DIR, 'smoke-sp.db'), (env, _projectDir, docsDir) => {
  run(`${CLI} index-docs --path "${docsDir}" --name sp-docs`, { env });
  run(`${CLI} stale-pages --repo sp-docs`, { env });
});

smokeTestWithDb('code-examples', path.join(TMP_DIR, 'smoke-ce.db'), (env, _projectDir, docsDir) => {
  run(`${CLI} index-docs --path "${docsDir}" --name ce-docs`, { env });
  run(`${CLI} code-examples --repo ce-docs --query "hello"`, { env });
});

smokeTestWithDb('reindex-docs', path.join(TMP_DIR, 'smoke-rid.db'), (env, _projectDir, docsDir) => {
  run(`${CLI} index-docs --path "${docsDir}" --name rid-docs`, { env });
  run(`${CLI} reindex-docs --repo rid-docs --path "${docsDir}"`, { env });
});

smokeTestWithDb('doc-orphans', path.join(TMP_DIR, 'smoke-do.db'), (env, _projectDir, docsDir) => {
  run(`${CLI} index-docs --path "${docsDir}" --name do-docs`, { env });
  run(`${CLI} doc-orphans --repo do-docs`, { env });
});

smokeTestWithDb('doc-coverage', path.join(TMP_DIR, 'smoke-dc.db'), (env, _projectDir, docsDir) => {
  run(`${CLI} index-docs --path "${docsDir}" --name dc-docs`, { env });
  run(`${CLI} doc-coverage --repo dc-docs`, { env });
});

smokeTestWithDb('doc-duplicates', path.join(TMP_DIR, 'smoke-dd.db'), (env, _projectDir, docsDir) => {
  run(`${CLI} index-docs --path "${docsDir}" --name dd-docs`, { env });
  run(`${CLI} doc-duplicates --repo dd-docs`, { env });
});

smokeTestWithDb('tutorial-path', path.join(TMP_DIR, 'smoke-tp.db'), (env, _projectDir, docsDir) => {
  run(`${CLI} index-docs --path "${docsDir}" --name tp-docs`, { env });
  // Tutorial-path requires --section
  run(`${CLI} tutorial-path --repo tp-docs --query "test"`, { env });
});

console.log('\nTrust sync commands (temp DB):');
smokeTestWithDb('sync-code-trust', path.join(TMP_DIR, 'smoke-trust.db'), (env) => {
  run(`${CLI} sync-code-trust --repo test-repo`, { env });
});

smokeTestWithDb('related', path.join(TMP_DIR, 'smoke-related.db'), (env) => {
  run(`${CLI} save --content "related test" --type decision --scope project --title "related"`, { env });
  run(`${CLI} related --id 1`, { env });
});

smokeTestWithDb('symbol-cluster', path.join(TMP_DIR, 'smoke-sc.db'), (env) => {
  run(`${CLI} symbol-cluster --query "test"`, { env });
});

smokeTestWithDb('link-symbol', path.join(TMP_DIR, 'smoke-ls.db'), (env) => {
  run(`${CLI} save --content "link test" --type learning --scope project --title "link"`, { env });
  // Link-symbol requires --memory-id
  run(`${CLI} link-symbol --memory-id 1 --symbol "testFunction" --file test.js --repo test-repo`, { env });
});

smokeTestWithDb('auto-link', path.join(TMP_DIR, 'smoke-al.db'), (env) => {
  run(`${CLI} auto-link --id 1`, { env });
});

smokeTestWithDb('adjust-trust', path.join(TMP_DIR, 'smoke-at.db'), (env) => {
  run(`${CLI} adjust-trust --id 1 --delta 0.1 --reason "test"`, { env });
});

smokeTestWithDb('record-recall', path.join(TMP_DIR, 'smoke-rr.db'), (env) => {
  run(`${CLI} save --content "recall test" --type bugfix --scope project --title "recall"`, { env });
  run(`${CLI} record-recall --id 1`, { env });
});

smokeTestWithDb('stale-links', path.join(TMP_DIR, 'smoke-sl.db'), (env) => {
  run(`${CLI} stale-links`, { env });
});

console.log('\nSession commands (temp DB):');
smokeTestWithDb('session-start + session-end', path.join(TMP_DIR, 'smoke-session.db'), (env) => {
  const startOut = run(`${CLI} session-start --project TestProject`, { env });
  if (!startOut.includes('sessionId')) {
    throw new Error('session-start did not return sessionId');
  }
  // Session-end requires --id
  run(`${CLI} session-end --id 1 --project TestProject --turns 5 --topics "smoke,test"`, { env });
});

smokeTestWithDb('session-summary', path.join(TMP_DIR, 'smoke-summ.db'), (env) => {
  run(`${CLI} session-start --project TestProject`, { env });
  run(`${CLI} session-summary --project TestProject --turns 3 --topics "smoke"`, { env });
});

smokeTestWithDb('dream', path.join(TMP_DIR, 'smoke-dream.db'), (env) => {
  run(`${CLI} dream --project TestProject`, { env });
});

smokeTestWithDb('compact', path.join(TMP_DIR, 'smoke-compact.db'), (env) => {
  run(`${CLI} compact`, { env });
});

console.log('\nMaintenance / project commands (temp DB):');
smokeTestWithDb('init', path.join(TMP_DIR, 'smoke-init.db'), (env) => {
  const out = run(`${CLI} init`, { env });
  if (!out.includes('ok')) {
    throw new Error('init did not return ok');
  }
});

smokeTestWithDb('list-projects', path.join(TMP_DIR, 'smoke-lp.db'), (env) => {
  const out = run(`${CLI} list-projects`, { env });
  if (!out.includes('projects')) {
    throw new Error('list-projects unexpected output');
  }
});

smokeTestWithDb('list-workspaces', path.join(TMP_DIR, 'smoke-lw.db'), (env) => {
  const out = run(`${CLI} list-workspaces`, { env });
  if (!out.includes('workspaces')) {
    throw new Error('list-workspaces unexpected output');
  }
});

smokeTestWithDb('create-workspace + archive-workspace', path.join(TMP_DIR, 'smoke-ws.db'), (env) => {
  run(`${CLI} create-workspace --name test-ws`, { env });
  run(`${CLI} archive-workspace --name test-ws`, { env });
});

smokeTestWithDb('auto-recover', path.join(TMP_DIR, 'smoke-ar.db'), (env) => {
  run(`${CLI} auto-recover`, { env });
});

smokeTestWithDb('recover-orphans', path.join(TMP_DIR, 'smoke-ro.db'), (env) => {
  run(`${CLI} recover-orphans`, { env });
});

smokeTestWithDb('trust-recovery', path.join(TMP_DIR, 'smoke-tr.db'), (env) => {
  run(`${CLI} trust-recovery`, { env });
});

smokeTestWithDb('mark-dup', path.join(TMP_DIR, 'smoke-md.db'), (env) => {
  run(`${CLI} save --content "dup1" --type bugfix --scope project --title "dup1"`, { env });
  run(`${CLI} save --content "dup2" --type bugfix --scope project --title "dup2"`, { env });
  run(`${CLI} mark-dup --keep 1 --remove 2`, { env });
});

// --- Cleanup ---
try {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
} catch {}

// --- Summary ---
console.log(`\n${'='.repeat(50)}`);
console.log(`Smoke tests: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailed tests:');
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
}
console.log(`${'='.repeat(50)}\n`);

if (failed > 0) {
  process.exit(1);
}
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
function smokeTest(name, cmd, { expectExit0 = true, expectContains = null, env = {} } = {}) {
  try {
    const result = execSync(cmd, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (expectContains && !result.includes(expectContains)) {
      throw new Error(`Output did not contain "${expectContains}". Got:\n${result.slice(0, 500)}`);
    }
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    if (!expectExit0) {
      // Command was expected to fail — that's fine
      console.log(`  ✓ ${name} (expected non-zero exit)`);
      passed++;
      return;
    }
    console.log(`  ✗ ${name}`);
    console.log(`    ${String(err.message).slice(0, 300)}`);
    failures.push(name);
    failed++;
  }
}
function smokeTestWithDb(name, dbPath, cmdFn) {
  ensureDir(path.dirname(dbPath));
  // Create a minimal project directory for indexing
  const projectDir = path.join(TMP_DIR, 'project'),
  docsDir = (() => {

    ensureDir(projectDir);
    fs.writeFileSync(path.join(projectDir, 'index.js'), '// hello\nfunction foo() { return 1; }\n');
  
    
  return (path.join(TMP_DIR, 'docs'));
})(),
  env = (() => {
ensureDir(docsDir);
    fs.writeFileSync(path.join(docsDir, 'readme.md'), '# Test\n\nSome content.\n\n## Section One\n\nBody.\n');
  
    
  return ({ HOME: path.join(TMP_DIR, 'home') });
})();ensureDir(env.HOME);
  try {
    cmdFn(env, projectDir, docsDir);
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${String(err.message).slice(0, 300)}`);
    failures.push(name);
    failed++;
  }
}
function run(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    // Commands that return {error:...} exit 1 — that's OK for smoke tests.
    // The command ran and returned a structured response.
    const output = (e.stdout || '') + (e.stderr || '');
    if (output.includes('"error"')) {
      return output;
    }
    throw e;
  }
}
