const {
  insertObservation,
  softDeleteObservation,
  hardDeleteObservation,
  getObservation,
  updateObservation,
  getTimeline,
  insertUserPrompt,
  getObservationStats,
} = require('../data-access/observations');

function mockDeps() {
  return {
    sqlJson: vi.fn(),
    sqlRun: vi.fn(),
  };
}

describe('data-access/observations', () => {
  describe('insertObservation', () => {
    it('should insert an observation and return result', () => {
      const deps = mockDeps(),
        result = (() => {
          deps.sqlJson.mockReturnValue([{ id: 1, created_at: '2024-01-01' }]);

          return insertObservation(deps, {
            sessionId: '1',
            type: 'decision',
            title: 'Test',
            content: 'Content',
            project: 'proj',
            scope: 'project',
            topicKey: null,
          });
        })();
      expect(deps.sqlJson).toHaveBeenCalledTimes(1);
      expect(result[0].id).toBe(1);
    });
  });

  describe('softDeleteObservation', () => {
    it('should update deleted_at and remove from FTS', () => {
      const deps = mockDeps();
      softDeleteObservation(deps, 42);
      expect(deps.sqlRun).toHaveBeenCalledWith(
        "UPDATE observations SET deleted_at = datetime('now') WHERE id = ?",
        [42],
      );
    });

    it('keeps the FTS index consistent on a real DB (#378)', () => {
      const Database = require('better-sqlite3'),
        db = new Database(':memory:');
      db.exec(require('fs').readFileSync(require('path').resolve(__dirname, '..', 'schema.sql'), 'utf8'));
      const sqlRun = (sql, params = []) => db.prepare(sql).run(...params),
        sid = db.prepare("INSERT INTO session_log (project) VALUES ('p')").run().lastInsertRowid,
        ins = db.prepare('INSERT INTO observations (session_id, type, title, content, project) VALUES (?, ?, ?, ?, ?)');
      for (const n of [1, 2, 3]) {
        ins.run(sid, 'decision', `busy timeout ${n}`, 'busy timeout setting', 'p');
      }
      softDeleteObservation({ sqlRun }, 1);
      softDeleteObservation({ sqlRun }, 2);
      // rank=1 also checks the index against the content table.
      expect(() =>
        db.exec("INSERT INTO observations_fts(observations_fts, rank) VALUES('integrity-check', 1)"),
      ).not.toThrow();
      expect(() => db.prepare('DELETE FROM observations WHERE id = 1').run()).not.toThrow();
      db.close();
    });
  });

  describe('hardDeleteObservation', () => {
    it('should hard delete an observation', () => {
      const deps = mockDeps();
      hardDeleteObservation(deps, 42);
      expect(deps.sqlRun).toHaveBeenCalledWith('DELETE FROM observations WHERE id = ?', [42]);
    });
  });

  describe('getObservation', () => {
    it('should query observation by id', () => {
      const deps = mockDeps(),
        result = (() => {
          deps.sqlJson.mockReturnValue([{ id: 5, title: 'Test' }]);

          return getObservation(deps, 5);
        })();
      expect(deps.sqlJson).toHaveBeenCalledWith(expect.stringContaining('FROM observations WHERE id = ?'), [5]);
      expect(result[0].id).toBe(5);
    });
  });

  describe('updateObservation', () => {
    it('should update title and return updated row', () => {
      const deps = mockDeps(),
        result = (() => {
          deps.sqlJson.mockReturnValue([{ id: 1, title: 'Updated' }]);

          return updateObservation(deps, { id: 1, title: 'Updated' });
        })();
      expect(deps.sqlRun).toHaveBeenCalled();
      expect(result[0].title).toBe('Updated');
    });

    it('should return null if no fields to update', () => {
      const deps = mockDeps(),
        result = updateObservation(deps, { id: 1 });
      expect(result).toBeNull();
    });
  });

  describe('getTimeline', () => {
    it('should query observations around an id', () => {
      const deps = mockDeps();
      deps.sqlJson.mockReturnValue([{ id: 5 }, { id: 10 }]);
      getTimeline(deps, { id: 10, before: 5, after: 5 });
      expect(deps.sqlJson).toHaveBeenCalledWith(expect.stringContaining('WHERE id BETWEEN'), [5, 15]);
    });
  });

  describe('insertUserPrompt', () => {
    it('should insert a prompt', () => {
      const deps = mockDeps();
      deps.sqlJson.mockReturnValue([{ id: 1, created_at: '2024-01-01' }]);
      insertUserPrompt(deps, { sessionId: '1', content: 'test', project: 'proj' });
      expect(deps.sqlJson).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO user_prompts'), expect.any(Array));
    });
  });

  describe('getObservationStats', () => {
    it('should return stats counts', () => {
      const deps = mockDeps(),
        result = (() => {
          deps.sqlJson
            .mockReturnValueOnce([{ cnt: 10 }])
            .mockReturnValueOnce([{ cnt: 5 }])
            .mockReturnValueOnce([{ cnt: 3 }])
            .mockReturnValueOnce([{ cnt: 2 }]);

          return getObservationStats(deps);
        })();
      expect(result.total_observations).toBe(10);
      expect(result.total_prompts).toBe(5);
      expect(result.total_sessions).toBe(3);
      expect(result.total_symbol_links).toBe(2);
    });
  });
});
