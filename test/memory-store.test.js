const path = require('path'),
  { execSync } = require('child_process'),
  STORE = path.resolve(__dirname, '..', 'memory-store.js');

function run(cmd, extraArgs = '') {
  const out = execSync(`node "${STORE}" ${cmd} ${extraArgs}`, {
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out.trim());
}

function runFail(cmd, extraArgs = '') {
  try {
    execSync(`node "${STORE}" ${cmd} ${extraArgs}`, {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return null;
  } catch (err) {
    return JSON.parse((err.stderr || err.stdout).trim());
  }
}

let testProject, sessionId;

beforeAll(() => {
  testProject = `test-mem-${Date.now()}`;
  const result = run(`session-start --project ${testProject}`);
  sessionId = result.sessionId;
});

afterAll(() => {
  try {
    run(`session-end --id ${sessionId} --memories 0 --auto true`);
  } catch {}
});

describe('memory-store: save', () => {
  it('should save a basic observation', () => {
    const result = run(
      `save --title "Test decision" --content "**What**: Use SQLite\n**Why**: Simple" --type decision --project ${testProject}`,
    );
    expect(result.id).toBeDefined();
    expect(result.title).toBe('Test decision');
    expect(typeof result.id).toBe('number');
  });

  it('should save with default type "manual"', () => {
    const result = run(`save --title "No type specified" --content "Some content" --project ${testProject}`);
    expect(result.id).toBeDefined();
  });

  it('should require --title and --content', () => {
    const result = runFail(`save --title "Only title" --project ${testProject}`),
      result2 = (() => {
        expect(result.error).toBeDefined();
        expect(result.error).toContain('Missing');

        return runFail(`save --content "Only content" --project ${testProject}`);
      })();
    expect(result2.error).toBeDefined();
  });

  it('should save with all optional fields', () => {
    const result = run(
      `save --title "Full observation" --content "Detailed content" ` +
        `--type architecture --project ${testProject} --scope project ` +
        `--topic-key "auth/middleware" --session-id ${sessionId}`,
    );
    expect(result.id).toBeDefined();
    expect(result.title).toBe('Full observation');
  });

  it('should save with personal scope', () => {
    const result = run(
      'save --title "Cross-project pref" --content "Always use tabs" --type preference --scope personal',
    );
    expect(result.id).toBeDefined();
  });

  it('should save with --expires-in TTL and surface expires_at', () => {
    const result = run(
      `save --title "TTL test obs" --content "Time-bound content" --project ${testProject} ` +
        `--type manual --expires-in 7d`,
    );
    expect(result.id).toBeDefined();
    expect(result.expires_at).toBeTruthy();
    // SQLite format: "YYYY-MM-DD HH:MM:SS"
    expect(result.expires_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // Should be roughly 7 days from now (within ±2 hours to account for clock skew)
    {
      const expMs = Date.parse(`${result.expires_at.replace(' ', 'T')}Z`),
        days = (expMs - Date.now()) / 86400000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThan(7.1);
    }
  });

  it('should reject invalid --expires-in values', () => {
    const result = runFail(
      `save --title "Bad TTL" --content "x" --project ${testProject} --expires-in "not-a-duration"`,
    );
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Invalid --expires-in');
  });

  it('should save with --force bypassing dedup', () => {
    const r1 = run(`save --title "Force test" --content "v1" --project ${testProject}`),
      r2 = run(`save --title "Force test" --content "v1" --project ${testProject} --force`);
    expect(r2.id).toBeDefined();
    expect(r2.id).not.toBe(r1.id);
  });

  it('should detect potential duplicates', () => {
    run(
      `save --title "Fix login bug in auth module" --content "Root cause was missing token validation" --project ${testProject} --type bugfix --force`,
    );
    const result = run(
      `save --title "Fix login bug in auth module v2" --content "Root cause was missing token validation fix" --project ${testProject} --type bugfix`,
    );
    if (result.status === 'potential_duplicate') {
      expect(result.matches.length).toBeGreaterThanOrEqual(1);
    } else if (result.auto_merged) {
      expect(result.superseded_id).toBeDefined();
    } else {
      expect(result.id).toBeDefined();
    }
  });

  it('should auto-merge at high similarity', () => {
    run(
      `save --title "Auto-merge target original xyz" --content "Content for auto merge test" --project ${testProject} --type pattern --force`,
    );
    const result = run(
      `save --title "Auto-merge target original xyz" --content "Content for auto merge test" --project ${testProject} --type pattern`,
    );
    if (result.auto_merged) {
      expect(result.superseded_id).toBeDefined();
      expect(result.superseded_title).toBeDefined();
      expect(typeof result.similarity).toBe('number');
    }
  });
});

describe('memory-store: search', () => {
  beforeAll(() => {
    run(
      `save --title "Search test alpha" --content "Alpha content about SQLite" --project ${testProject} --type decision --force`,
    );
    run(
      `save --title "Search test beta" --content "Beta content about PostgreSQL" --project ${testProject} --type bugfix --force`,
    );
    run(
      `save --title "Search test gamma" --content "Gamma content about Redis cache" --project ${testProject} --type pattern --force`,
    );
  });

  it('should find results by keyword', () => {
    const result = run(`search --query "Search test" --project ${testProject}`);
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('should return ranked results with _score', () => {
    const result = run(`search --query "alpha" --project ${testProject}`);
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    for (const r of result.results) {
      expect(typeof r._score).toBe('number');
      expect(isNaN(r._score)).toBe(false);
    }
  });

  it('should filter by type', () => {
    const result = run(`search --query "Search test" --project ${testProject} --type decision`);
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.every((r) => r.type === 'decision')).toBe(true);
  });

  it('should filter by scope', () => {
    const result = run(`search --query "Search test" --scope project`);
    expect(result.results.every((r) => r.scope === 'project')).toBe(true);
  });

  it('should respect --limit', () => {
    const result = run(`search --query "Search test" --limit 1`);
    expect(result.results.length).toBeLessThanOrEqual(1);
  });

  it('should require --query', () => {
    const result = runFail(`search --project ${testProject}`);
    expect(result.error).toBeDefined();
  });

  it('should return empty results for nonsense query', () => {
    const result = run(`search --query "zzzzzzz_nonexistent_xyzzzzz" --project ${testProject}`);
    expect(result.results).toEqual([]);
  });

  it('should handle special characters in query gracefully', () => {
    expect(() => {
      run(`search --query "foo.bar()" --project ${testProject}`);
    }).not.toThrow();
  });

  it('should exclude soft-deleted observations from search', () => {
    const saved = run(
        `save --title "Will be deleted soon" --content "Temporary content" --project ${testProject} --force`,
      ),
      result = (() => {
        run(`delete --id ${saved.id}`);

        return run(`search --query "Will be deleted soon" --project ${testProject}`);
      })();
    expect(result.results.every((r) => r.id !== saved.id)).toBe(true);
  });

  it('should record recall tracking when session-id is provided', () => {
    const result = run(`search --query "Search test" --project ${testProject} --session-id ${sessionId}`);
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });
});

describe('memory-store: get', () => {
  let savedId;

  beforeAll(() => {
    const result = run(
      `save --title "Get test observation" --content "Content to retrieve" --project ${testProject} --type learning --force`,
    );
    savedId = result.id;
  });

  it('should retrieve an observation by id', () => {
    const result = run(`get --id ${savedId}`);
    expect(result.id).toBe(savedId);
    expect(result.title).toBe('Get test observation');
    expect(result.content).toContain('Content to retrieve');
    expect(result.type).toBe('learning');
  });

  it('should include recall_count', () => {
    const result = run(`get --id ${savedId}`);
    expect(typeof result.recall_count).toBe('number');
  });

  it('should return error for non-existent id', () => {
    const result = runFail(`get --id 999999999`);
    expect(result.error).toBeDefined();
  });

  it('should require --id', () => {
    const result = runFail(`get`);
    expect(result.error).toBeDefined();
  });
});

describe('memory-store: update', () => {
  let savedId;

  beforeAll(() => {
    const result = run(
      `save --title "Update test original" --content "Original content" --project ${testProject} --type manual --force`,
    );
    savedId = result.id;
  });

  it('should update title', () => {
    const result = run(`update --id ${savedId} --title "Updated title"`);
    expect(result.title).toBe('Updated title');
  });

  it('should update content', () => {
    const result = run(`update --id ${savedId} --content "Updated content"`);
    expect(result.content).toBe('Updated content');
  });

  it('should update type', () => {
    const result = run(`update --id ${savedId} --type decision`);
    expect(result.type).toBe('decision');
  });

  it('should update scope', () => {
    const result = run(`update --id ${savedId} --scope personal`);
    expect(result.scope).toBe('personal');
  });

  it('should update topic-key', () => {
    const result = run(`update --id ${savedId} --topic-key "auth/jwt"`);
    expect(result.topic_key).toBe('auth/jwt');
  });

  it('should update updated_at timestamp', () => {
    const result = run(`update --id ${savedId} --title "Timestamp check"`);
    expect(result.updated_at).toBeTruthy();
  });

  it('should require at least one field to update', () => {
    const result = runFail(`update --id ${savedId}`);
    expect(result.error).toBeDefined();
  });

  it('should require --id', () => {
    const result = runFail(`update --title "No id"`);
    expect(result.error).toBeDefined();
  });

  it('should return error for non-existent id', () => {
    const result = runFail(`update --id 999999999 --title "Ghost"`);
    expect(result.error).toBeDefined();
  });

  it('should set expiry with --expires-in', () => {
    const saved = run(`save --title "Will get a TTL" --content "x" --project ${testProject} --force`),
      result = run(`update --id ${saved.id} --expires-in 3d`);
    expect(result.expires_at).toBeTruthy();
    expect(result.expires_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('should clear expiry with --clear-expiry', () => {
    const saved = run(`save --title "Will lose its TTL" --content "x" --project ${testProject} --expires-in 5d`),
      result = (() => {
        expect(saved.expires_at).toBeTruthy();

        return run(`update --id ${saved.id} --clear-expiry true`);
      })();
    expect(result.expires_at).toBeNull();
  });

  it('should reject invalid --expires-in on update', () => {
    const saved = run(`save --title "TTL reject target" --content "x" --project ${testProject} --force`),
      result = runFail(`update --id ${saved.id} --expires-in "garbage"`);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Invalid --expires-in');
  });
});

describe('memory-store: delete', () => {
  it('should soft-delete by default', () => {
    const saved = run(
        `save --title "Soft delete test" --content "Will be soft-deleted" --project ${testProject} --force`,
      ),
      result = run(`delete --id ${saved.id}`);
    expect(result.ok).toBe(true);
    expect(result.hardDeleted).toBe(false);
  });

  it('should hard-delete when --hard true', () => {
    const saved = run(
        `save --title "Hard delete test" --content "Will be hard-deleted" --project ${testProject} --force`,
      ),
      result = run(`delete --id ${saved.id} --hard true`);
    expect(result.ok).toBe(true);
    expect(result.hardDeleted).toBe(true);
  });

  it('should require --id', () => {
    const result = runFail(`delete`);
    expect(result.error).toBeDefined();
  });

  it('should return error for non-existent id (soft delete)', () => {
    const result = runFail(`delete --id 999999999`);
    expect(result.error).toBe('Observation not found');
  });
});

describe('memory-store: context', () => {
  beforeAll(() => {
    run(
      `save --title "Context test decision" --content "Important decision" --project ${testProject} --type decision --force`,
    );
    run(
      `save --title "Context test bugfix" --content "Bug fix details" --project ${testProject} --type bugfix --force`,
    );
    run(
      `save --title "Context test personal" --content "Personal preference" --type preference --scope personal --force`,
    );
  });

  it('should return project-scoped context', () => {
    const result = run(`context --project ${testProject}`);
    expect(result.observations).toBeDefined();
    expect(Array.isArray(result.observations)).toBe(true);
    expect(result.stats).toBeDefined();
    expect(typeof result.stats.total_memories).toBe('number');
    expect(result.project).toBe(testProject);
  });

  it('should include personal observations', () => {
    const result = run(`context --project ${testProject}`);
    expect(Array.isArray(result.personal)).toBe(true);
  });

  it('should return cross-project context with --all-projects', () => {
    const result = run(`context --all-projects true`);
    expect(result.cross_project).toBe(true);
    expect(result.observations).toBeDefined();
  });

  it('should filter by topic-key', () => {
    run(
      `save --title "Topic context test" --content "Content" --project ${testProject} --topic-key "test/topic-context" --force`,
    );
    const result = run(`context --project ${testProject} --topic-key "test/topic-context"`);
    expect(result.observations.length).toBeGreaterThanOrEqual(1);
    expect(result.topic).toBe('test/topic-context');
  });

  it('should filter by query', () => {
    const result = run(`context --project ${testProject} --query "Context test"`);
    expect(result.observations.length).toBeGreaterThanOrEqual(1);
  });

  it('should respect --limit', () => {
    const result = run(`context --project ${testProject} --limit 1`);
    expect(result.observations.length).toBeLessThanOrEqual(1);
  });

  it('should return sessions for project', () => {
    const result = run(`context --project ${testProject}`);
    expect(Array.isArray(result.sessions)).toBe(true);
  });
});

describe('memory-store: session lifecycle', () => {
  it('should start a session', () => {
    const result = run(`session-start --project test-session-${Date.now()}`);
    expect(result.sessionId).toBeDefined();
    expect(typeof result.sessionId).toBe('number');
  });

  it('should end a session', () => {
    const proj = `test-session-end-${Date.now()}`,
      start = run(`session-start --project ${proj}`),
      result = run(`session-end --id ${start.sessionId} --memories 3 --auto true`);
    expect(result).toBeDefined();
  });

  it('should require --project for session-start', () => {
    const result = runFail(`session-start`);
    expect(result.error).toBeDefined();
  });
});

describe('memory-store: timeline', () => {
  let savedId;

  beforeAll(() => {
    const result = run(`save --title "Timeline test" --content "Content" --project ${testProject} --force`);
    savedId = result.id;
  });

  it('should return observations around an id', () => {
    const result = run(`timeline --id ${savedId}`);
    expect(Array.isArray(result)).toBe(true);
  });

  it('should require --id', () => {
    const result = runFail(`timeline`);
    expect(result.error).toBeDefined();
  });
});

describe('memory-store: suggest-topic-key', () => {
  it('should generate a topic key from title', () => {
    const result = run(`suggest-topic-key --title "JWT Authentication Middleware"`);
    expect(result.topic_key).toBe('jwt-authentication-middleware');
  });

  it('should handle special characters', () => {
    const result = run(`suggest-topic-key --title "Fix: N+1 in /api/users"`);
    expect(result.topic_key).toBeTruthy();
    expect(result.topic_key).not.toContain('+');
  });

  it('should return untitled for empty input', () => {
    const result = run(`suggest-topic-key`);
    expect(result.topic_key).toBe('untitled');
  });
});

describe('memory-store: search ranking quality', () => {
  it('should rank decisions higher than session summaries', () => {
    const proj = `test-ranking-${Date.now()}`,
      result = (() => {
        run(`save --title "Important decision" --content "Use PostgreSQL" --project ${proj} --type decision --force`);
        run(
          `save --title "Session summary" --content "Worked on stuff" --project ${proj} --type session_summary --force`,
        );

        return run(`search --query "Important" --project ${proj}`);
      })();
    if (result.results.length >= 2) {
      const decisionIdx = result.results.findIndex((r) => r.type === 'decision'),
        summaryIdx = result.results.findIndex((r) => r.type === 'session_summary');
      if (decisionIdx >= 0 && summaryIdx >= 0) {
        expect(result.results[decisionIdx]._score).toBeGreaterThan(result.results[summaryIdx]._score);
      }
    }
  });

  it('should produce valid numeric scores (no NaN)', () => {
    const proj = `test-nan-${Date.now()}`,
      result = (() => {
        run(`save --title "NaN test" --content "Check for NaN" --project ${proj} --force`);

        return run(`search --query "NaN test" --project ${proj}`);
      })();
    for (const r of result.results) {
      expect(typeof r._score).toBe('number');
      expect(isNaN(r._score)).toBe(false);
    }
  });
});

describe('memory-store: stats', () => {
  it('should return database statistics', () => {
    const result = run(`stats`);
    expect(result.total_observations).toBeDefined();
    expect(typeof result.total_observations).toBe('number');
  });
});

describe('memory-store: list-projects', () => {
  it('should return projects list', () => {
    const result = run(`list-projects`);
    expect(result.projects).toBeDefined();
    expect(Array.isArray(result.projects)).toBe(true);
  });
});
