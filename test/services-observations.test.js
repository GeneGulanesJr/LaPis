const obsService = require('../services/observations');

describe('services/observations', () => {
  describe('suggestTopicKey', () => {
    it('should convert text to kebab-case topic key', () => {
      const result = obsService.suggestTopicKey({ title: 'Use SQLite for storage' });
      expect(result.topic_key).toBe('use-sqlite-for-storage');
    });

    it('should handle special characters', () => {
      const result = obsService.suggestTopicKey({ title: 'Fix: Bug #123 in auth/SSO!' });
      expect(result.topic_key).toMatch(/^[a-z0-9-]+$/);
    });

    it('should use content when title is missing', () => {
      const result = obsService.suggestTopicKey({ content: 'Architecture decision: use PostgreSQL' });
      expect(result.topic_key).toBe('architecture-decision-use-postgresql');
    });

    it('should return untitled for empty input', () => {
      const result = obsService.suggestTopicKey({});
      expect(result.topic_key).toBe('untitled');
    });

    it('should collapse multiple hyphens', () => {
      const result = obsService.suggestTopicKey({ title: 'A   B   C' });
      expect(result.topic_key).toBe('a-b-c');
    });

    it('should strip leading and trailing hyphens', () => {
      const result = obsService.suggestTopicKey({ title: '---middle---' });
      expect(result.topic_key).toBe('middle');
    });
  });

  describe('save', () => {
    it('should return error when title is missing', () => {
      const deps = {
          jsonErrNoExit: vi.fn((msg) => ({ error: msg })),
          insertObservation: vi.fn(),
          insertObservationRelation: vi.fn(),
          softDeleteObservation: vi.fn(),
          checkDuplicate: vi.fn(),
          findLatestSession: vi.fn(),
        },
        result = obsService.save(deps, { content: 'hello' });
      expect(result.error).toContain('title');
      expect(result.error).not.toContain('content');
    });

    it('should return error when content is missing', () => {
      const deps = {
          jsonErrNoExit: vi.fn((msg) => ({ error: msg })),
          insertObservation: vi.fn(),
          insertObservationRelation: vi.fn(),
          softDeleteObservation: vi.fn(),
          checkDuplicate: vi.fn(),
          findLatestSession: vi.fn(),
        },
        result = obsService.save(deps, { title: 'hello' });
      expect(result.error).toContain('content');
      expect(result.error).not.toContain('title');
    });

    it('should report both --title and --content when both are missing', () => {
      const deps = {
          jsonErrNoExit: vi.fn((msg) => ({ error: msg })),
          insertObservation: vi.fn(),
          insertObservationRelation: vi.fn(),
          softDeleteObservation: vi.fn(),
          checkDuplicate: vi.fn(),
          findLatestSession: vi.fn(),
        },
        result = obsService.save(deps, {});
      expect(result.error).toBe('Missing --title and --content');
    });

    it('should insert observation when valid and no duplicates', () => {
      const insertObservation = vi.fn(() => [{ id: 42, created_at: '2025-01-01' }]),
        insertObservationRelation = vi.fn(),
        softDeleteObservation = vi.fn(),
        checkDuplicate = vi.fn(() => ({ potential_duplicates: [] })),
        findLatestSession = vi.fn(() => '1'),
        jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
        deps = {
          jsonErrNoExit,
          insertObservation,
          insertObservationRelation,
          softDeleteObservation,
          checkDuplicate,
          findLatestSession,
        },
        result = obsService.save(deps, { title: 'Test', content: 'Body', type: 'decision', project: 'proj' });
      expect(result.id).toBe(42);
      expect(insertObservation).toHaveBeenCalled();
      expect(checkDuplicate).toHaveBeenCalledWith('Test', 'decision', 'proj', null);
    });

    it('should auto-merge when duplicate similarity exceeds threshold', () => {
      const insertObservation = vi.fn(() => [{ id: 99, created_at: '2025-01-01' }]),
        insertObservationRelation = vi.fn(),
        softDeleteObservation = vi.fn(),
        checkDuplicate = vi.fn(() => ({
          potential_duplicates: [{ id: 10, title: 'Similar', similarity: 0.9 }],
        })),
        findLatestSession = vi.fn(() => '1'),
        jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
        deps = {
          jsonErrNoExit,
          insertObservation,
          insertObservationRelation,
          softDeleteObservation,
          checkDuplicate,
          findLatestSession,
        },
        result = obsService.save(deps, { title: 'Test', content: 'Body', project: 'proj' });
      expect(result.auto_merged).toBe(true);
      expect(result.superseded_id).toBe(10);
      expect(softDeleteObservation).toHaveBeenCalledWith(10);
      expect(insertObservationRelation).toHaveBeenCalled();
    });

    it('should return potential_duplicate status when similarity is below threshold', () => {
      const insertObservation = vi.fn(),
        checkDuplicate = vi.fn(() => ({
          potential_duplicates: [{ id: 5, title: 'Somewhat similar', similarity: 0.5 }],
        })),
        findLatestSession = vi.fn(() => '1'),
        jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
        deps = {
          jsonErrNoExit,
          insertObservation,
          checkDuplicate,
          findLatestSession,
          insertObservationRelation: vi.fn(),
          softDeleteObservation: vi.fn(),
        },
        result = obsService.save(deps, { title: 'Test', content: 'Body' });
      expect(result.status).toBe('potential_duplicate');
      expect(insertObservation).not.toHaveBeenCalled();
    });

    it('should force save when --force is set', () => {
      const insertObservation = vi.fn(() => [{ id: 55, created_at: '2025-01-01' }]),
        checkDuplicate = vi.fn(() => ({
          potential_duplicates: [{ id: 10, title: 'Similar', similarity: 0.95 }],
        })),
        findLatestSession = vi.fn(() => '1'),
        jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
        deps = {
          jsonErrNoExit,
          insertObservation,
          checkDuplicate,
          findLatestSession,
          insertObservationRelation: vi.fn(),
          softDeleteObservation: vi.fn(),
        },
        result = obsService.save(deps, { title: 'Test', content: 'Body', force: 'true' });
      expect(result.id).toBe(55);
      expect(insertObservation).toHaveBeenCalled();
    });
  });

  describe('capturePassive', () => {
    it('should return error when content is missing', () => {
      const jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
        deps = { jsonErrNoExit, insertCapturePassiveObservation: vi.fn(), findLatestSession: vi.fn() },
        result = obsService.capturePassive(deps, {});
      expect(result.error).toContain('content');
    });

    it('should return empty when no Key Learning section', () => {
      const jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
        findLatestSession = vi.fn(() => '1'),
        insertCapturePassiveObservation = vi.fn(),
        deps = { jsonErrNoExit, insertCapturePassiveObservation, findLatestSession },
        result = obsService.capturePassive(deps, { content: 'Just regular text without learnings' });
      expect(result.extracted).toBe(0);
      expect(result.items).toEqual([]);
    });

    it('should extract bullet points from Key Learning', () => {
      const jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
        findLatestSession = vi.fn(() => '1'),
        insertCapturePassiveObservation = vi.fn(),
        deps = { jsonErrNoExit, insertCapturePassiveObservation, findLatestSession },
        content =
          '## Key Learning:\n\n- Use SQLite for storage\n- Prefer event-driven architectures\n- Always add tests',
        result = obsService.capturePassive(deps, { content });
      expect(result.extracted).toBe(3);
      expect(insertCapturePassiveObservation).toHaveBeenCalledTimes(3);
    });

    it('should extract numbered items from Key Learnings', () => {
      const jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
        findLatestSession = vi.fn(() => '1'),
        insertCapturePassiveObservation = vi.fn(),
        deps = { jsonErrNoExit, insertCapturePassiveObservation, findLatestSession },
        content = '## Key Learnings:\n\n1. First lesson\n2. Second lesson',
        result = obsService.capturePassive(deps, { content });
      expect(result.extracted).toBeGreaterThanOrEqual(1);
    });

    it('should truncate long items to SUMMARY_MAX_LENGTH', () => {
      const { CAPTURE_PASSIVE } = require('../constants'),
        jsonErrNoExit = vi.fn((msg) => ({ error: msg })),
        findLatestSession = vi.fn(() => '1'),
        insertCapturePassiveObservation = vi.fn(),
        deps = { jsonErrNoExit, insertCapturePassiveObservation, findLatestSession },
        longItem = 'a'.repeat(CAPTURE_PASSIVE.SUMMARY_MAX_LENGTH + 50),
        content = `## Key Learnings:\n\n- ${longItem}`,
        call = (() => {
          obsService.capturePassive(deps, { content });
          expect(insertCapturePassiveObservation).toHaveBeenCalled();

          return insertCapturePassiveObservation.mock.calls[0][0];
        })();
      expect(call.summary.length).toBeLessThanOrEqual(CAPTURE_PASSIVE.SUMMARY_MAX_LENGTH);
    });
  });
});
