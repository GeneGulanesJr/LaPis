# Dream Cycle

The Dream Cycle is LaPis' memory-quality cleanup pass. It targets stale or low-value memory, not old memory.

It runs once **per active session**, triggered when the in-session turn counter reaches **turn 50** (see Issue #194 / PR #195). Before that change it ran per project every 10 sessions after `session-end`; the trigger moved into the session so the cycle can act on fresh turn context. A 6-month-old valid decision should stay; a 1-day-old superseded setup note can be removed or consolidated.

For databases created before the trigger moved, run the one-shot retroactive cleanup:

```bash
node memory-store.js cleanup-sessions
```

This consolidates accumulated `session_summary` observations into one per project and prunes empty/orphaned sessions, mirroring what the in-session cycle now does automatically.

## What It Cleans

| Phase               | What it cleans                                                   | Why it is stale                      |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------ |
| Superseded          | Memories with `duplicate` or `supersedes` relations.             | A newer memory replaces it.          |
| Stale auto-progress | `progress` and `accomplished` entries with zero recall.          | Never useful, just noise.            |
| Stale auto-detected | Auto-detected decisions with zero recall and low trust.          | Pattern-matched junk never acted on. |
| Stale corrections   | Titles starting with `CORRECTION:`.                              | Should have used `update` instead.   |
| Replaced configs    | Superseded setup/config memories.                                | Setup information was replaced.      |

## What It Does Not Do

- It does not delete memory because of age alone.
- It does not replace explicit user decisions with inferred memories.
- It does not run only at session end. As of Issue #194, the cycle triggers at turn 50 of each active session, then once more at `session-end` if it did not already run.

## Related Maintenance

`compact` is separate housekeeping. It prunes dead links, decays trust, runs SQLite vacuum, and optimizes FTS5.

`dream` is semantic cleanup. It reviews whether memories are superseded, never recalled, low-trust, or better represented by an existing updated memory.
