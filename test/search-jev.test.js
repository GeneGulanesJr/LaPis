// vitest globals enabled — no import
const { jevRerank, LEVELS } = require('../src/memory-domain/search-jev');

function makeRow(i) {
  return { id: i, title: `t${i}`, snippet: `s${i}` };
}

function makeRows(n) {
  return Array.from({ length: n }, (_, i) => makeRow(i));
}

function makeJudge(answers, meta = {}) {
  return vi.fn(async () => ({ status: meta.status || 'ok', answers, reason: meta.reason }));
}

describe('jevRerank — Slice A recall rerank (advisory)', () => {
  it('empty rows → unchanged, reranked:false, judge never called', async () => {
    const judge = makeJudge([]);
    const r = await jevRerank([], 'auth flow', { _judge: judge });
    expect(r.reranked).toBe(false);
    expect(r.rows).toEqual([]);
    expect(judge).not.toHaveBeenCalled();
  });

  it('grades re-stable the head (central > related > irrelevant, ties keep lexical order) with jev annotations; tail preserved', async () => {
    // 12 rows, default topN 10 → head = 0..9, tail = 10..11
    const rows = makeRows(12);
    const judge = makeJudge([
      { id: 'rr-0', level: 0, confidence: 0.7 }, // irrelevant
      { id: 'rr-1', level: 2, confidence: 0.9 }, // central
      { id: 'rr-2', level: 1, confidence: 0.8 }, // related
      { id: 'rr-3', level: 2, confidence: 0.85 }, // central
      { id: 'rr-4', level: 1, confidence: 0.8 },
      { id: 'rr-5', level: 1, confidence: 0.8 },
      { id: 'rr-6', level: 1, confidence: 0.8 },
      { id: 'rr-7', level: 1, confidence: 0.8 },
      { id: 'rr-8', level: 1, confidence: 0.8 },
      { id: 'rr-9', level: 1, confidence: 0.8 },
    ]);
    const r = await jevRerank(rows, 'auth flow', { _judge: judge });
    expect(r.reranked).toBe(true);
    expect(r.unavailable).toBeUndefined();
    expect(r.rows.map((x) => x.id)).toEqual([1, 3, 2, 4, 5, 6, 7, 8, 9, 0, 10, 11]);
    // graded rows carry jev annotations
    expect(r.rows[0].jev).toEqual({ level: 2, confidence: 0.9, relevance: 'central' });
    expect(r.rows[1].jev).toEqual({ level: 2, confidence: 0.85, relevance: 'central' });
    expect(r.rows[2].jev).toEqual({ level: 1, confidence: 0.8, relevance: 'related' });
    expect(r.rows[9].jev).toEqual({ level: 0, confidence: 0.7, relevance: 'irrelevant' });
    // tail rows pass through untouched (no jev field)
    expect(r.rows[10]).toEqual({ id: 10, title: 't10', snippet: 's10' });
    expect(r.rows[11]).toEqual({ id: 11, title: 't11', snippet: 's11' });
    // original input rows not mutated (graded copies carry jev)
    expect(rows[1].jev).toBeUndefined();
    // questions are grade-kind with recall surface
    expect(judge.mock.calls[0][1]).toEqual({ surface: 'recall' });
    expect(judge.mock.calls[0][0][0].judgment).toEqual({ kind: 'grade', levels: LEVELS });
  });

  it('judge unavailable status → input order unchanged + unavailable:true', async () => {
    const rows = makeRows(4);
    const judge = makeJudge([], { status: 'unavailable', reason: 'off' });
    const r = await jevRerank(rows, 'q', { _judge: judge });
    expect(r.reranked).toBe(false);
    expect(r.unavailable).toBe(true);
    expect(r.rows.map((x) => x.id)).toEqual([0, 1, 2, 3]);
    expect(r.rows.every((x) => x.jev === undefined)).toBe(true);
  });

  it('judge that throws is contained → input order unchanged', async () => {
    const rows = makeRows(4);
    const judge = vi.fn(async () => {
      throw new Error('boom');
    });
    const r = await jevRerank(rows, 'q', { _judge: judge });
    expect(r.reranked).toBe(false);
    expect(r.unavailable).toBe(true);
    expect(r.rows.map((x) => x.id)).toEqual([0, 1, 2, 3]);
  });

  it('batch cap: 25 rows topN 25 → 3 judge calls (10/10/5)', async () => {
    const rows = makeRows(25);
    const answers = Array.from({ length: 25 }, (_, i) => ({ id: `rr-${i}`, level: 1, confidence: 0.8 }));
    const judge = makeJudge(answers);
    const r = await jevRerank(rows, 'q', { _judge: judge, topN: 25 });
    expect(r.reranked).toBe(true);
    expect(judge).toHaveBeenCalledTimes(3);
    expect(judge.mock.calls.map((c) => c[0].length)).toEqual([10, 10, 5]);
  });

  it('missing answers for some ids → those rows level 0, no crash', async () => {
    const rows = makeRows(5);
    const judge = makeJudge([
      { id: 'rr-1', level: 2, confidence: 0.9 },
      { id: 'rr-3', level: 2, confidence: 0.9 },
    ]);
    const r = await jevRerank(rows, 'q', { _judge: judge });
    expect(r.reranked).toBe(true);
    expect(r.rows.map((x) => x.id)).toEqual([1, 3, 0, 2, 4]);
    const unanswered = r.rows.filter((x) => [0, 2, 4].includes(x.id));
    for (const row of unanswered) {
      expect(row.jev.level).toBe(0);
      expect(row.jev.confidence).toBe(0);
      expect(row.jev.relevance).toBe('irrelevant');
    }
  });
});
