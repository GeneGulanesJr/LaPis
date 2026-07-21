const { createDb, sqlJson, sqlRun } = require('../db');
const { createAurexRepository } = require('../src/platform/storage/repositories');

// Wires an isolated in-memory DB (with full schema) onto the global sqlJson/sqlRun.
// The aurex repository accepts that same { sqlJson, sqlRun } shape.
const deps = { sqlJson, sqlRun };

let initialized = false;
beforeAll(() => {
  if (!initialized) {
    createDb({ db_path: ':memory:' });
    initialized = true;
  }
});

function setupMissionWithTodos(repo, todos) {
  repo.createMissionLedger({ missionId: 'm1', missionTitle: 'priority mission', status: 'in_progress' });
  for (const t of todos) {
    repo.createTodo('m1', { status: 'ready', ...t });
  }
  return repo;
}

describe('claimNextReadyTodo priority ordering', () => {
  it('claims high before medium before low (not lexicographic order)', () => {
    const repo = createAurexRepository(deps);
    // Insert out of priority order so a naive lexicographic DESC sort
    // (medium > low > high) would surface the wrong todo first.
    setupMissionWithTodos(repo, [
      { id: 'td-low', priority: 'low', title: 'low todo' },
      { id: 'td-med', priority: 'medium', title: 'medium todo' },
      { id: 'td-high', priority: 'high', title: 'high todo' },
    ]);

    const first = repo.claimNextReadyTodo('m1', 'w1')[0];
    const second = repo.claimNextReadyTodo('m1', 'w1')[0];
    const third = repo.claimNextReadyTodo('m1', 'w1')[0];

    expect(first.id).toBe('td-high');
    expect(second.id).toBe('td-med');
    expect(third.id).toBe('td-low');
  });

  it('returns empty when no ready todos remain', () => {
    const repo = createAurexRepository(deps);
    repo.createMissionLedger({ missionId: 'm2', missionTitle: 'empty', status: 'in_progress' });
    expect(repo.claimNextReadyTodo('m2', 'w1')).toEqual([]);
  });
});
