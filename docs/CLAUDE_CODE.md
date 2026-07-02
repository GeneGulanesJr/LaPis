# Claude Code Integration

LaPis ships first-class support for the [Claude Code CLI](https://code.claude.com/docs/en/overview). Claude Code gets the same hook-driven experience Pi has — auto context injection, passive capture, trust sync, session lifecycle, and tool guardrails — not just bare MCP tools.

Claude Code integration runs over **two separate config systems** that LaPis never mixes:

| System | Config file | What it wires |
| --- | --- | --- |
| **MCP tools** | `.mcp.json` (project) or `~/.claude.json` (user/local) | `mcp__lapis__memory-*`, `mcp__lapis__memory-code`, etc. |
| **Hooks** | `.claude/settings.json` (project) or `~/.claude/settings.json` (user) | Session lifecycle, guardrails, passive capture, tracking |

See the [Claude Code hooks spec](https://code.claude.com/docs/en/hooks) and [MCP config docs](https://code.claude.com/docs/en/mcp) for upstream details.

## Quick start

From your project root:

```bash
npx -y @genegulanesjr/lapis claude-code install
```

Then start an interactive Claude Code session in the same directory. On first use, approve the LaPis MCP server when prompted (`/mcp`).

Verify the install:

```bash
npx -y @genegulanesjr/lapis claude-code doctor
```

Uninstall (reverses only LaPis-owned entries):

```bash
npx -y @genegulanesjr/lapis claude-code uninstall
```

## Install options

```bash
lapis claude-code install [flags]
```

| Flag | Purpose |
| --- | --- |
| `--global` | User scope: hooks → `~/.claude/settings.json`, MCP → `~/.claude.json` top-level `mcpServers`. |
| `--mcp-name <name>` | MCP server name (default `lapis`). Tool names become `mcp__<name>__*`. |
| `--no-claude-md` | Skip appending the memory-usage protocol block to `.claude/CLAUDE.md`. |
| `--bin <path>` | Command resolution: bare name on PATH (`lapis`), or `node <script>` for a local clone. Machine-specific paths go to `.claude/settings.local.json` and `~/.claude.json` local scope. |
| `--auto-allow` | Pre-approve `mcp__<name>__*` in `permissions.allow` (default off — you approve on first use). |
| `--daemon` | Start a detached `lapis serve` and write the daemon lockfile so hooks POST to `/dispatch` instead of cold-starting per hook. |
| `--daemon-port <port>` | Daemon port when `--daemon` is set (default `9100`). |

**Command resolution ladder** (portability vs speed):

1. **npx** (default) — `npx -y @genegulanesjr/lapis …` — portable, committable.
2. **global bin** — `--bin lapis` — fastest direct spawn, still PATH-relative and committable.
3. **local clone** — `--bin ./memory-store.js` — machine-specific; hooks land in `settings.local.json`.
4. **daemon** — `--daemon` — optional perf tier; hooks reuse a warm `lapis serve` process via `POST /dispatch`.

Manage the daemon separately:

```bash
lapis claude-code start [--port 9100] [--host 127.0.0.1] [--detached]
lapis claude-code stop
```

## Two-config layout

After install, your project typically has:

```text
.mcp.json                          # MCP server: npx -y @genegulanesjr/lapis mcp
.claude/
  settings.json                    # Hook handlers (exec-form command hooks)
  CLAUDE.md                        # Memory protocol block (<!-- lapis:start --> … <!-- lapis:end -->)
```

With `--global`, hooks and MCP move to user scope. With machine-specific `--bin` paths, hooks go to `.claude/settings.local.json` (gitignored) and MCP to `~/.claude.json` under `projects[<cwd>].mcpServers` — the committable files are never touched with absolute paths.

Re-install is idempotent: LaPis hook handlers are identified by a sentinel (`claude-code hook <Event>` in the args array) and replaced in place; MCP servers are deduped by name and resolved command string.

## Hook → feature mapping

| Claude Code event | LaPis behavior |
| --- | --- |
| `SessionStart` (`startup` \| `resume` \| `clear`) | `session-start` dispatch + inject context |
| `SessionStart` (`compact`) | Re-inject only (no new session-start) |
| `UserPromptSubmit` | Prompt-matched context + preflight + cadence-gated memory reminder (30s budget) |
| `PreToolUse` `Read` | Block whole-file reads of indexed code |
| `PreToolUse` `Grep` / `Glob` | **Primary** code-search guardrail (agent is instructed to prefer these over bash grep/find) |
| `PreToolUse` `Bash` (search cmds) | Secondary search guardrail via `if`-field rules (`grep`, `rg`, `ag`, `ack`, `find`) |
| `PreToolUse` `mcp__lapis__memory-code` | Seed `exploredFiles` |
| `PostToolUse` `Write` \| `Edit` \| `MultiEdit` | Edit-track (sync) |
| `PostToolUse` `Bash` (git ops) | `sync-code-trust` (async) |
| `PostToolUse` `mcp__lapis__memory-code` | Harvest file paths into `exploredFiles` |
| `PostToolUse` `mcp__lapis__memory-save` \| `search` \| `get` \| `delete` | **Tool-state mirroring** (counters + recall feedback) — process-boundary fix |
| `Stop` | Passive-capture + checkpoint + dream (silent, async) |
| `SessionEnd` | `session-summary` + `session-end` (awaited, DB-derived count) |

Hooks are wired as exec-form command handlers, e.g.:

```json
{
  "type": "command",
  "command": "npx",
  "args": ["-y", "@genegulanesjr/lapis", "claude-code", "hook", "SessionStart"],
  "timeout": 30
}
```

Heavy handlers (`Stop`, git-trust `PostToolUse`) run with `async: true`. `PostToolUse` is split with `--skip git-trust` / `--only git-trust` so tracking stays synchronous while trust sync runs in the background.

## State storage

Claude Code spawns a **fresh process per hook event**. The in-process `state` object Pi's extension mutates is invisible across hook invocations.

LaPis persists per-session state to:

```text
~/.pi/memory/claude-sessions/<claude_session_id>.json
```

Fields mirror the Pi extension's session state (`sessionId`, `turnCount`, `editedFiles`, `exploredFiles`, `memoriesSavedThisSession`, `pendingRecallFeedback`, etc.). The main SQLite database stays at `~/.pi/memory/memory.db` (configurable via `~/.pi/memory/config.jsonc`).

**Shared config is intentional.** LaPis does **not** fork a `~/.claude/` database or fragment memories. The same `~/.pi/memory/` store is shared across Pi, Claude Code, and the MCP server — memories, code indexes, and trust scores stay in one place.

## First-use MCP approval

Project-scoped `.mcp.json` servers show as **"⏸ Pending approval"** until you approve them inside an interactive `claude` session (`/mcp`). This is Claude Code's security model, not LaPis.

To skip manual approval (e.g. in trusted dev environments):

```bash
lapis claude-code install --auto-allow
```

## Deliberate divergences from Pi

| Area | Pi extension | Claude Code bridge |
| --- | --- | --- |
| Guardrail auto-indexing on miss | May trigger indexing | **Deferred** — would blow the hook timeout budget |
| MCP tool search scope | Project-scoped | Project-scoped (same) |
| Config / DB path | `~/.pi/memory/` | `~/.pi/memory/` (shared — not forked) |
| Output compression | Replaces bash tool result in place | **Not wired** — `PostToolUse` cannot rewrite an already-executed tool result (see [deferred follow-up](#deferred-output-compression)) |
| Process model | In-process `state` | Disk-backed `claude-sessions/` + tool-state mirroring on `PostToolUse` |

## Troubleshooting

### Silent DB init

If the database has never been initialized, the first hook call runs `ensureDb()` silently. If initialization fails (permissions, corrupt schema), the hook logs to **stderr** and exits non-zero for DB errors — but handler crashes still **fail open** (exit 0) so Claude Code is never blocked.

Check manually:

```bash
lapis claude-code doctor
node memory-store.js stats
```

### stdio-only errors

Hook handlers write the Claude Code JSON decision to **stdout only**. All diagnostics go to **stderr**. If hooks appear to do nothing, inspect stderr:

```bash
echo '{}' | npx -y @genegulanesjr/lapis claude-code hook SessionStart 2>debug.log
```

### Hooks fail open

By design, a timed-out or crashed hook lets the tool call proceed. Guardrail reliability matters — if a `PreToolUse` handler crashes, the read/search is **not** blocked. Check stderr for `claude-code <event> handler error:` lines.

Timeouts are tuned per handler: 15s for `PreToolUse`/`PostToolUse` tracking, 30s for lifecycle events, 60s for async `Stop` and git-trust.

### MCP tools work but hooks do not

Run `lapis claude-code doctor`. Common causes:

- Hooks file missing or LaPis handlers stripped — re-run `install`.
- `better-sqlite3` native module mismatch — run `npm install` in the LaPis checkout or use `npx` so the published binary matches your Node version.
- Machine-specific `--bin` path moved — re-install or update `.claude/settings.local.json`.

### Daemon mode not used

Hooks auto-select daemon dispatch when `LAPIS_DAEMON_URL` is set or `~/.pi/memory/claude-daemon.json` points at a live process. Otherwise they cold-start direct dispatch. Start the daemon with `lapis claude-code start --detached` or install with `--daemon`.

## Programmatic access

The hook router is published as an npm subpath export (install, doctor, and daemon lifecycle remain CLI-only via `lapis` / `lapis-cc`):

```js
const { runHook } = require('@genegulanesjr/lapis/claude-code');
const hooksEngine = require('@genegulanesjr/lapis/hooks-engine');
```

`lapis-cc` is a bin alias for `lapis` — both resolve to `memory-store.js`.

See [`MODULE_MAP.md`](MODULE_MAP.md) for module ownership.

## Deferred: output compression

Pi's `output-compression` **replaces** the bash tool result in place. Claude Code's `PostToolUse` cannot rewrite an already-executed tool's result.

A follow-up option: emit the compressed summary as `additionalContext` on the same `PostToolUse` so Claude still sees the savings note without the raw bytes. This is tracked separately and is not required for parity.

## See also

- [`docs/COMMANDS.md`](COMMANDS.md) — `claude-code` subcommand reference
- [`docs/CONFIGURATION.md`](CONFIGURATION.md) — `~/.pi/memory/config.jsonc`
- [`docs/MODULE_MAP.md`](MODULE_MAP.md) — `src/claude-code/` and `src/hooks-engine/` ownership
- [Epic #205](https://github.com/GeneGulanesJr/LaPis/issues/205) — full phased breakdown
