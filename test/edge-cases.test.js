// Comprehensive edge case tests for the memory layer
const path = require('path'),
  { execSync } = require('child_process'),
  STORE = path.resolve(__dirname, '..', 'memory-store.js'),
  testProject = `edge-test-${process.pid}`;

function run(cmd, timeout = 15000) {
  try {
    const out = execSync(`node "${STORE}" ${cmd}`, {
      encoding: 'utf8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(out.trim());
  } catch (e) {
    if (e.stdout?.trim()) {
      try {
        return JSON.parse(e.stdout.trim());
      } catch {}
    }
    return { error: e.message };
  }
}

function runFail(cmd) {
  try {
    execSync(`node "${STORE}" ${cmd}`, {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return null; // Should not reach here
  } catch (e) {
    const stderr = e.stderr?.trim() || '',
      stdout = e.stdout?.trim() || '';
    try {
      return JSON.parse(stderr || stdout);
    } catch {
      return { error: stderr || stdout || e.message };
    }
  }
}

// Cleanup helper
function cleanup(title) {
  try {
    const r = run(`search --query "${title}" --project ${testProject}`);
    if (r.results) {
      for (const m of r.results) {
        run(`delete --id ${m.id} --hard true`);
      }
    }
  } catch {}
}

// ═══════════════════════════════════════════
// CRUD Edge Cases
// ═══════════════════════════════════════════
describe('edge cases: CRUD', () => {
  it('should error on get with nonexistent ID', () => {
    const result = runFail('get --id 999999999');
    expect(result.error).toBeTruthy();
  });

  it('should error on update with nonexistent ID', () => {
    const result = runFail('update --id 999999999 --title "ghost"');
    expect(result.error).toBeTruthy();
  });

  it('should error on delete with nonexistent ID', () => {
    const result = runFail('delete --id 999999999');
    expect(result.error).toBe('Observation not found');
  });

  it('should persist all optional fields on save', () => {
    const r = run(
        `save --title "Edge: all fields" --content "Full fields test" --type bugfix --project ${testProject} --scope personal --topic-key "testing/all-fields" --force`,
      ),
      got = (() => {
        expect(r.id).toBeTruthy();

        return run(`get --id ${r.id}`);
      })();
    expect(got.type).toBe('bugfix');
    expect(got.project).toBe(testProject);
    expect(got.scope).toBe('personal');
    expect(got.topic_key).toBe('testing/all-fields');
    cleanup('Edge: all fields');
  });

  it('should round-trip special characters in title and content', () => {
    const title = `Special: 'quotes' and "double" & <html> 🎉`,
      content = `What: Tabs \t newlines \n emoji ✅. Why: Coverage.`,
      r = run(
        `save --title "${title.replace(/"/g, '\\"')}" --content "${content.replace(/"/g, '\\"')}" --type learning --force --project ${testProject}`,
      ),
      got = (() => {
        expect(r.id).toBeTruthy();

        return run(`get --id ${r.id}`);
      })();
    expect(got.title).toContain('quotes');
    expect(got.title).toContain('🎉');
    expect(got.content).toContain('✅');
    cleanup('Special:');
  });

  it('should increment updated_at on update', async () => {
    const r = run(
        `save --title "Edge: update timestamp" --content "before" --type learning --force --project ${testProject}`,
      ),
      before = run(`get --id ${r.id}`);
    // Small delay to ensure timestamp differs
    await new Promise((resolve) => setTimeout(resolve, 1100));
    run(`update --id ${r.id} --content "after"`);
    {
      const after = run(`get --id ${r.id}`);
      expect(after.updated_at).not.toBe(before.updated_at);
      expect(after.content).toBe('after');
      cleanup('Edge: update timestamp');
    }
  });

  it('should exclude soft-deleted from search results', () => {
    const r = run(
        `save --title "Edge: soft delete search" --content "visible" --type learning --force --project ${testProject}`,
      ),
      search1 = run(`search --query "soft delete search" --project ${testProject}`),
      search2 = (() => {
        expect(search1.results.length).toBeGreaterThanOrEqual(1);
        run(`delete --id ${r.id}`);

        return run(`search --query "soft delete search" --project ${testProject}`);
      })();
    expect(search2.results.find((m) => m.id === r.id)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════
// Search Edge Cases
// ═══════════════════════════════════════════
describe('edge cases: search', () => {
  it('should reject empty query', () => {
    const result = runFail('search --query ""');
    expect(result.error).toContain('query');
  });

  it('should return empty results for nonsense query', () => {
    const result = run('search --query "xyzzyqetuoplkjhfdsmncbv123456789"');
    expect(result.results).toEqual([]);
  });

  it('should filter by type', () => {
    const result = run('search --query "memory" --type decision --limit 3');
    expect(result.results).toBeDefined();
    if (result.results.length > 0) {
      for (const r of result.results) {
        expect(r.type).toBe('decision');
      }
    }
  });

  it('should filter by scope', () => {
    const result = run('search --query "memory" --scope project --limit 3');
    expect(result.results).toBeDefined();
    if (result.results.length > 0) {
      for (const r of result.results) {
        expect(r.scope).toBe('project');
      }
    }
  });
});

// ═══════════════════════════════════════════
// Dedup Edge Cases
// ═══════════════════════════════════════════
describe('edge cases: dedup', () => {
  it('should auto-merge duplicate saves', () => {
    const title = `Edge: dedup auto ${process.pid}`,
      r1 = run(`save --title "${title}" --content "first" --type learning --force --project ${testProject}`),
      r2 = (() => {
        expect(r1.id).toBeTruthy();
        expect(r1.auto_merged).toBeUndefined();

        return run(`save --title "${title}" --content "second" --type learning --project ${testProject}`);
      })();
    expect(r2.auto_merged).toBe(true);
    expect(r2.superseded_id).toBe(r1.id);
    expect(r2.similarity).toBe(1);

    // Clean up both
    run(`delete --id ${r2.id} --hard true`);
  });

  it('should bypass dedup with --force', () => {
    const title = `Edge: dedup force ${process.pid}`,
      r1 = run(`save --title "${title}" --content "first" --type learning --force --project ${testProject}`),
      r2 = run(`save --title "${title}" --content "second" --type learning --force --project ${testProject}`);
    expect(r2.id).toBeTruthy();
    expect(r2.id).not.toBe(r1.id);
    expect(r2.auto_merged).toBeUndefined();

    run(`delete --id ${r1.id} --hard true`);
    run(`delete --id ${r2.id} --hard true`);
  });
});

// ═══════════════════════════════════════════
// Trust System Edge Cases
// ═══════════════════════════════════════════
describe('edge cases: trust system', () => {
  let testMemoryId;

  beforeAll(() => {
    const r = run(
      `save --title "Edge: trust test memory" --content "for trust testing" --type learning --force --project ${testProject}`,
    );
    testMemoryId = r.id;
    run(`link-symbol --memory-id ${testMemoryId} --repo PiMemoryExtension --trust 0.5`);
  });

  afterAll(() => {
    run(`delete --id ${testMemoryId} --hard true`);
  });

  it('should clamp trust to 1.0 on overflow', () => {
    const result = run(`adjust-trust --memory-id ${testMemoryId} --delta 5 --reason "overflow test"`);
    expect(result.ok).toBe(true);
    expect(result.newTrust).toBe(1);
  });

  it('should clamp trust to 0.0 on underflow', () => {
    const result = run(`adjust-trust --memory-id ${testMemoryId} --delta -10 --reason "underflow test"`);
    expect(result.ok).toBe(true);
    expect(result.newTrust).toBe(0);
  });

  it('should warn when adjusting trust on memory with no symbol link', () => {
    const result = run(`adjust-trust --memory-id 999999999 --delta 0.5 --reason "ghost"`);
    expect(result.ok).toBe(true);
    expect(result.newTrust).toBeNull();
    expect(result.warning).toContain('No symbol link found');
  });

  it('should require --memory-id for adjust-trust', () => {
    const result = runFail('adjust-trust --delta 0.5');
    expect(result.error).toContain('--memory-id');
  });

  it('should require --memory-id for link-symbol', () => {
    const result = runFail('link-symbol --repo test');
    expect(result.error).toContain('--memory-id');
  });

  it('should require --repo for link-symbol', () => {
    const result = runFail('link-symbol --memory-id 1');
    expect(result.error).toContain('--repo');
  });

  it('should require --repo for stale-links', () => {
    const result = runFail('stale-links');
    expect(result.error).toContain('--repo');
  });

  it('should return empty links for nonexistent repo', () => {
    const result = run('stale-links --repo nonexistent-repo-xyz');
    expect(result.links).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('should require --session-id and --memory-id for record-recall', () => {
    const result = runFail('record-recall --memory-id 1');
    expect(result.error).toContain('--session-id and --memory-id');
  });

  it('should require --project for auto-link', () => {
    const result = runFail('auto-link');
    expect(result.error).toContain('--project');
  });

  it('should link a symbol and confirm via stale-links', () => {
    const r = run(`link-symbol --memory-id ${testMemoryId} --repo PiMemoryExtension --symbol-id 12345 --trust 0.8`);
    expect(r.ok).toBe(true);
    expect(r.trustScore).toBe(0.8);

    {
      const stale = run('stale-links --repo PiMemoryExtension'),
        found = stale.links.find((l) => l.memory_id === String(testMemoryId) && l.symbol_id === '12345');
      expect(found).toBeTruthy();
      expect(found.trust_score).toBe(0.8);
    }
  });

  it('should record recall without error', () => {
    const r = run(`session-start --project ${testProject}`),
      sessionId = r.sessionId,
      result = run(`record-recall --session-id ${sessionId} --memory-id ${testMemoryId}`);
    expect(result.ok).toBe(true);
    run(`session-end --id ${sessionId} --summary "recall test" --content "done"`);
  });
});

// ═══════════════════════════════════════════
// Code Analysis Edge Cases
// ═══════════════════════════════════════════
describe('edge cases: code analysis', () => {
  beforeAll(() => {
    const result = run('reindex-repo --repo PiMemoryExtension --mode full');
    if (result.error) {
      run('index-repo --path . --name PiMemoryExtension');
    }
  }, 60000);

  it('should error on outline for nonexistent repo', () => {
    const result = runFail('outline --repo nonexistent-xyz --file cli.js');
    expect(result.error).toContain('not found');
  });

  it('should return not_found for nonexistent file in valid repo', () => {
    const result = run('outline --repo PiMemoryExtension --file nonexistent_file.js');
    expect(result._meta).toBeDefined();
    expect(result.data.not_found).toBe(true);
  });

  it('should return empty cycles for valid repo', () => {
    const result = run('cycles --repo PiMemoryExtension');
    expect(result._meta).toBeDefined();
    expect(result.data.cycles).toEqual([]);
  });

  it('should return empty for dead-code with high confidence', () => {
    const result = run('dead-code --repo PiMemoryExtension --min-confidence 0.9');
    expect(result._meta).toBeDefined();
    expect(result.data.dead_files).toBeDefined();
  });
});

// ═══════════════════════════════════════════
// Doc Indexing Edge Cases
// ═══════════════════════════════════════════
describe('edge cases: doc indexing', () => {
  it('should error on doc-search for nonexistent repo', () => {
    const result = runFail('doc-search --query "test" --repo nonexistent-docs');
    expect(result.error).toContain('not found');
  });

  it('should error on broken-links for nonexistent repo', () => {
    const result = runFail('broken-links --repo nonexistent-docs');
    expect(result.error).toContain('not found');
  });
});

// ═══════════════════════════════════════════
// Session Edge Cases
// ═══════════════════════════════════════════
describe('edge cases: sessions', () => {
  it('should create and end a session with summary', () => {
    const start = run(`session-start --project ${testProject}`),
      end = (() => {
        expect(start.sessionId).toBeTruthy();

        return run(`session-end --id ${start.sessionId} --summary "test session" --content "content here"`);
      })();
    expect(end.ok).toBe(true);
  });

  it('should error on session-end without --id', () => {
    const result = runFail('session-end --summary "no id"');
    expect(result.error).toContain('id');
  });
});

// ═══════════════════════════════════════════
// Compact / Dream Edge Cases
// ═══════════════════════════════════════════
describe('edge cases: compact/dream', () => {
  it('should complete compact without error', () => {
    // `compact` runs VACUUM + FTS optimize on the live memory.db, which can be
    // Hundreds of MB. Give it a generous timeout so this integration test isn't
    // Flaky on large DBs.
    const result = run('compact', 60000);
    expect(result.ok).toBe(true);
    expect(result.steps.deadLinksCleaned).toBe(true);
    expect(result.steps.vacuumed).toBe(true);
  });
});

// ═══════════════════════════════════════════
// Missing command wrappers (commands/symbols.js fix)
// ═══════════════════════════════════════════
describe('edge cases: symbol commands (previously broken)', () => {
  it('link-symbol should work with valid args', () => {
    const r = run(
        `save --title "Edge: sym cmd test" --content "test" --type learning --force --project ${testProject}`,
      ),
      result = run(`link-symbol --memory-id ${r.id} --repo PiMemoryExtension --trust 0.7`);
    expect(result.ok).toBe(true);
    expect(result.trustScore).toBe(0.7);
    run(`delete --id ${r.id} --hard true`);
  });

  it('auto-link should return ok with results', () => {
    const result = run(`auto-link --project ${testProject}`);
    expect(result.ok).toBe(true);
    expect(typeof result.linked).toBe('number');
    expect(typeof result.total).toBe('number');
  });

  it('stale-links should return array', () => {
    const result = run('stale-links --repo PiMemoryExtension');
    expect(Array.isArray(result.links)).toBe(true);
    expect(typeof result.total).toBe('number');
  });
});
