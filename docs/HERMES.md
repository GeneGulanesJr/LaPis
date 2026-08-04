# Hermes Agent Integration

LaPis ships first-class support for [Hermes Agent](https://hermes-agent.nousresearch.com/) — the Nous Research open-source agent framework. Hermes gets the same persistent memory, code guardrails, and trust tracking as Pi and Claude Code, wired through Hermes' MCP client and shell-hook system.

Hermes integration runs over **two separate config systems** that LaPis never mixes, both inside the Hermes config file:

| System | Config file | What it wires |
| --- | --- | --- |
| **MCP tools** | `$HERMES_HOME/config.yaml` → `mcp_servers.lapis` | `mcp_lapis_memory-*`, `mcp_lapis_memory-code`, `mcp_lapis_memory-doc`, etc. |
| **Hooks** | `$HERMES_HOME/config.yaml` → `hooks:` + `$HERMES_HOME/shell-hooks-allowlist.json` | Read guardrail, post-edit trust sync, session-end |

`$HERMES_HOME` defaults to `~/.hermes` (set `HERMES_HOME` to override). LaPis also installs a Hermes **skill** (`$HERMES_HOME/skills/memory/lapis/SKILL.md`) that teaches the agent the retrieval protocols.

## Quick start

From any directory:

```bash
npx -y @genegulanesjr/lapis hermes install
```

This writes the MCP server entry, the three hook entries, first-use consent, and the skill. The MCP server entry pins `LAPIS_HOME` to your home directory so the server and CLI always share one SQLite database.

Then **restart Hermes** (or run `/reload-mcp` in a session) so the MCP tools load. Hooks register at process start; `hooks_auto_accept: true` is set so no consent prompts appear on non-TTY starts.

Verify the install:

```bash
npx -y @genegulanesjr/lapis hermes doctor
```

Uninstall (reverses only LaPis-owned entries):

```bash
npx -y @genegulanesjr/lapis hermes uninstall
```

Flags: `--mcp-name <name>` (default `lapis`), `--home <dir>` (override `$HERMES_HOME`), `--no-hooks`, `--no-skill`.

## Hook → feature mapping

Hermes shell hooks receive one JSON payload on stdin (`hook_event_name`, `tool_name`, `tool_input`, `session_id`, `cwd`, `extra`) and can print a block decision to stdout. The hook command is `<node> <lapis>/memory-store.js hermes hook` for every event — the dispatcher reads the event from the payload.

| Hermes hook event | LaPis behavior |
| --- | --- |
| `pre_llm_call` (every turn)      | Inject recalled memory context into the user message (`{"context": …}`; prompt-cache-safe, capped, fail-open silent) |
| `on_session_start` (new session) | Start a LaPis session row + persist the Hermes→LaPis session-id mapping |
| `pre_tool_call` (`read_file` \| `search_files`) | **Block** whole-file reads of indexed code → outline; **block broad search scans** → `memory-code search`; targeted reads/lookups allowed |
| `post_tool_call` (`write_file` \| `patch`) | Fire-and-forget `sync-code-trust` when the cwd is inside an indexed repo |
| `on_session_end` | Best-effort `session-end` (no-op when no LaPis session was started) |

Hooks **fail open**: an error, timeout, or ambiguity lets the tool proceed. LaPis hooks are identified by their exact command string, so uninstall removes only LaPis-owned entries and never touches other hooks you have configured.

## LAPIS_HOME

LaPis resolves its memory directory from `LAPIS_HOME` first, then `HOME` (see `db.js`). The installer pins `LAPIS_HOME` in the MCP server's `env` so the server subprocess uses the same SQLite database as the `lapis` CLI even when the hosting process (gateway/dashboard) was launched with a different `HOME`. The doctor reports whether the entry is pinned.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| MCP tools missing after install | Restart Hermes or run `/reload-mcp`; check `hermes mcp list` shows `lapis` enabled |
| Hooks not firing | Hooks register at process start — restart Hermes; check `hermes hooks list` shows `✓ allowed` |
| `hermes: command not found` in hook entries | Re-run `lapis hermes install` from the same Node environment; the hook command embeds `process.execPath` |
| `memory-code` says "Repo not found" | The MCP server and CLI use different databases — run `lapis hermes doctor`; the `LAPIS_HOME` pin fixes this on re-install |
| Hook consent prompt on headless start | `hooks_auto_accept: true` must be present (install sets it) |

## See also

- [`docs/CLAUDE_CODE.md`](CLAUDE_CODE.md) — Claude Code integration (MCP + hooks)
- [`docs/MCP.md`](MCP.md) — standalone MCP server (tools only)
- [`docs/MODULE_MAP.md`](MODULE_MAP.md) — `src/hermes/` ownership
