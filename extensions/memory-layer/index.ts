/**
 * Memory Layer Extension — Automatic persistent memory for Pi
 *
 * Hooks into Pi lifecycle events to automatically:
 * - Load smart context on session start (before_agent_start)
 * - Save decisions/bugfixes when the agent makes them (tool_result)
 * - Auto-save session summary on shutdown (session_shutdown)
 * - Provide memory tools the LLM can call directly
 *
 * No AGENTS.md text needed — this extension enforces memory usage via code.
 *
 * Requirements:
 *   - memory-store.js in the same directory as this extension
 *   - SQLite (node:sqlite, better-sqlite3, or sqlite3 CLI)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import path from "node:path";

// ── Config ──────────────────────────────────────────────────
// Resolve paths relative to the package root (two levels up from extensions/memory-layer/).
// Works whether installed as a pi package or cloned to ~/.pi/agent/skills/.
const PKG_ROOT = path.resolve(__dirname, "..", "..");
const MEMORY_SCRIPT = path.join(PKG_ROOT, "memory-store.js");

// ── Helpers ─────────────────────────────────────────────────

interface MemResult {
  [key: string]: unknown;
}

// Timeout defaults by command category (ms)
const TIMEOUT_DEFAULTS: Record<string, number> = {
  // Lightweight queries — fast
  _default: 15000,
  // Heavy analysis — needs more time
  "dead-code": 60000,
  cycles: 60000,
  "signal-chains": 45000,
  hotspots: 45000,
  importance: 45000,
  coupling: 30000,
  "blast-radius": 30000,
  churn: 30000,
  extractable: 30000,
  "import-graph": 30000,
  "call-hierarchy": 30000,
  // Indexing commands
  "index-repo": 120000,
  "reindex-repo": 120000,
  "index-docs": 120000,
  "reindex-docs": 120000,
};

function getTimeout(cmd: string): number {
  return TIMEOUT_DEFAULTS[cmd] ?? TIMEOUT_DEFAULTS._default;
}

function trustIcon(score: number): string {
  if (score < 0.5) {return " ⚠️";}
  if (score < 0.7) {return " 🔎";}
  return "";
}

async function mem(
  cmd: string,
  args: Record<string, string | number | boolean>,
): Promise<MemResult | null> {
  const argList: string[] = [cmd];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === "") {continue;}
    argList.push(`--${k}`);
    argList.push(String(v));
  }
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const timeout = getTimeout(cmd);
      const child = execFile("node", [MEMORY_SCRIPT, ...argList], {
        encoding: "utf8",
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB for large analyses
        stdio: ["pipe", "pipe", "pipe"],
      }, (err, stdout) => {
        if (err) {reject(err);}
        else {resolve(stdout.trim());}
      });
      // Ensure child is killed if orphaned
      child.on("error", reject);
    });
    return out ? JSON.parse(out) : null;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("timed out")) {
      console.error(`[memory-layer] ${cmd} timed out after ${getTimeout(cmd)}ms`);
    } else {
      console.error(`[memory-layer] ${cmd} failed:`, msg);
    }
    return null;
  }
}

async function memCmd(cmd: string): Promise<MemResult | null> {
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const timeout = getTimeout(cmd);
      execFile("node", [MEMORY_SCRIPT, cmd], {
        encoding: "utf8",
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      }, (err, stdout) => {
        if (err) {reject(err);}
        else {resolve(stdout.trim());}
      });
    });
    return out ? JSON.parse(out) : null;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[memory-layer] ${cmd} failed:`, msg);
    return null;
  }
}

async function detectProject(cwd: string): Promise<string> {
  const resolved = path.resolve(cwd);

  // Query all known projects once and cache
  let knownProjects: string[] = [];
  try {
    const result = await mem("list-projects", {});
    if (result && (result as any).projects) {
      knownProjects = ((result as any).projects as any[]).map((p: any) => p.project);
    }
  } catch (_) { /* DB may not exist yet */ }

  // First pass: match against indexed code repos by path (most specific wins)
  // This is more reliable than directory-name matching because it checks
  // The actual file paths stored in the code index, avoiding false matches
  // When a parent directory name coincidentally matches a memory project name.
  try {
    const codeRepos = await getKnownRepos();
    if (codeRepos.length > 0) {
      let bestRepo: { repo: RepoInfo; depth: number } | null = null;
      let dir = resolved;
      const root = path.parse(dir).root;
      while (dir !== root && dir !== path.dirname(dir)) {
        for (const repo of codeRepos) {
          if (dir.toLowerCase() === repo.path.toLowerCase()) {
            const depth = dir.split("/").length;
            if (!bestRepo || depth > bestRepo.depth) {
              bestRepo = { repo, depth };
            }
          }
        }
        dir = path.dirname(dir);
      }
      if (bestRepo) {return bestRepo.repo.name;}
    }
  } catch (_) { /* Code repos may not be available */ }

  // Second pass: walk up directory tree looking for known projects (case-insensitive)
  let dir = resolved;
  const root = path.parse(dir).root;
  while (dir !== root && dir !== path.dirname(dir)) {
    const name = path.basename(dir);
    // Case-insensitive match against known project names
    const match = knownProjects.find(p => p && p.toLowerCase() === name.toLowerCase());
    if (match) {return match;} // Return the canonical name from DB, not the filesystem one
    dir = path.dirname(dir);
  }

  // Fall back to basename
  return path.basename(resolved) || "unknown";
}

// ── State ───────────────────────────────────────────────────

// ── Repo index cache ──────────────────────────────────────
interface RepoInfo {
  name: string;
  path: string;
  indexed_at: string;
  file_count: number;
  symbol_count: number;
}
let cachedRepos: RepoInfo[] | null = null;
let repoCacheTime: number = 0;
const REPO_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getKnownRepos(): Promise<RepoInfo[]> {
  const now = Date.now();
  if (cachedRepos && now - repoCacheTime < REPO_CACHE_TTL) {return cachedRepos;}
  const result = await memCmd("list-code-repos");
  if (!result || !(result as any).repos) {return cachedRepos || [];}
  cachedRepos = (result as any).repos as RepoInfo[];
  repoCacheTime = now;
  return cachedRepos;
}

/** Time-based staleness heuristic: compare repo path mtime vs indexed_at */
function isRepoStale(repo: RepoInfo): boolean {
  try {
    const fs = require("fs");
    const stat = fs.statSync(repo.path);
    // Consider stale if directory was modified more than 1 hour after indexing
    const indexedTime = new Date(repo.indexed_at).getTime();
    const mtime = Math.max(stat.mtimeMs, stat.ctimeMs);
    return mtime > indexedTime + 3600000; // 1 hour grace period
  } catch {
    return false; // Can't check, assume OK
  }
}

// File extension heuristic for code files
const CODE_EXTENSIONS = new Set([
  ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi", ".pyx",
  ".go", ".rs", ".rb", ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp",
  ".cs", ".scala", ".clj", ".ex", ".exs", ".erl", ".hs", ".ml", ".zig",
]);

function isCodeFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

let sessionId: number | null = null;
let currentProject: string | null = null;
let memoriesSavedThisSession = 0;
let nudgeCountThisSession = 0;
const MAX_NUDGES_PER_SESSION = 8;
let exploredFiles = new Set<string>(); // Files explored via memory-code → allowed for read

// ── Reliability state ────────────────────────────────────
let turnCount = 0;
let llmCallCount = 0;
let lastMemoryToolCall = 0;         // Timestamp of last memory tool usage
let lastAutoDecisionSave = 0;       // Timestamp of last auto-detected decision save
let hasInjectedContext = false;      // Whether before_agent_start context was injected this turn
let editedFiles = new Set<string>(); // Files edited this session
const AUTO_DECISION_COOLDOWN = 60000; // 1 min between auto-decision saves
const MEMORY_REMINDER_INTERVAL = 8;   // Inject reminder every Nth LLM call
const CHECKPOINT_INTERVAL = 10;       // Save progress checkpoint every N turns

// ── Extension ───────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ────────────────────────────────────────────────────────
  // SESSION START — initialize memory session
  // ────────────────────────────────────────────────────────
  pi.on("session_start", async (event, ctx) => {
    currentProject = await detectProject(ctx.cwd);
    nudgeCountThisSession = 0;
    turnCount = 0;
    llmCallCount = 0;
    lastMemoryToolCall = 0;
    lastAutoDecisionSave = 0;
    hasInjectedContext = false;
    editedFiles = new Set();
    exploredFiles = new Set();
    cachedRepos = null;
    repoCacheTime = 0;

    const result = await mem("session-start", { project: currentProject });
    if (!result) {
      ctx.ui.notify("Memory: failed to start session", "error");
      return;
    }

    sessionId = result.sessionId as number;

    // Auto-recover only the current project's orphaned session
    // (session-start already recovers the most recent incomplete session for this project)
    // We do NOT call recover-orphans here — it creates one observation per orphan,
    // Which pollutes the observation pool with low-value session_summary entries.
    // Cross-project orphans are cleaned up lazily during compact/maintenance.
    if (result.recoveredSession) {
      ctx.ui.notify(
        `Memory: recovered orphaned session for ${currentProject}`,
        "info",
      );
    }

    ctx.ui.setStatus("memory", `🧠 session ${sessionId}`);

    // ── Auto-dream: every 10th session, run the Dream Cycle ──
    // Dream() targets STALENESS (superseded, zero-recall, stale corrections),
    // Not age. A 6-month-old valid decision stays. A 1-day-old superseded one goes.
    if (sessionId % 10 === 0) {
      try {
        const dreamResult = await memCmd("dream");
        if (dreamResult && (dreamResult as any).totalCleaned > 0) {
          ctx.ui.notify(
            `💤 Dream Cycle: ${(dreamResult as any).totalCleaned} memories cleaned (session #${sessionId})`,
            "info",
          );
        }
      } catch (e) {
        console.error("[memory-layer] auto-dream failed:", e);
      }
    }
  });

  // ────────────────────────────────────────────────────────
  // Fix #6: COMPACTION RECOVERY — re-inject memory context after /compact
  // Without this, compaction destroys the initial context injection and
  // The LLM completely loses awareness of memory tools and project context.
  // ────────────────────────────────────────────────────────
  pi.on("session_compact", async (_event, ctx) => {
    if (!currentProject) {return;}

    const contextResult = await mem("context", {
      project: currentProject,
      limit: "15",
      ...(sessionId ? { "session-id": String(sessionId) } : {}),
    });

    let crossProjectResult: MemResult | null = null;
    if (!contextResult || !((contextResult.observations as any[]) || []).length) {
      crossProjectResult = await mem("context", {
        "all-projects": "true",
        limit: "10",
        ...(sessionId ? { "session-id": String(sessionId) } : {}),
      });
    }

    if (!contextResult && !crossProjectResult) {return;}

    const isNewProject = crossProjectResult !== null;
    const effectiveObservations = isNewProject
      ? ((crossProjectResult!.observations as any[]) || [])
      : ((contextResult!.observations as any[]) || []);
    const stats = contextResult?.stats as any;
    const personal = (contextResult?.personal as any[]) || [];

    const lines: string[] = [
      "## Memory Context (re-injected after compaction)",
      "",
    ];

    if (isNewProject) {
      lines.push(`Project: **${currentProject}** | 🆕 new project`);
      if (effectiveObservations.length > 0) {
        lines.push("");
        lines.push("### 🔗 Related memories from other projects");
        for (const o of effectiveObservations.slice(0, 5)) {
          lines.push(`- [${o.type}] ${o.title}`);
        }
      }
    } else {
      lines.push(`Project: **${currentProject}** | ${stats?.total_memories || 0} memories`);
      if (effectiveObservations.length > 0) {
        lines.push("");
        lines.push("### Recent Relevant Memory");
        for (const o of effectiveObservations) {
          const trust = o.trust_score < 0.5 ? "⚠️" : o.trust_score < 0.8 ? "🔎" : "";
          lines.push(`- [${o.type}] ${o.title} ${trust}`);
        }
      }
    }

    if (personal.length > 0) {
      lines.push("");
      lines.push("### Your Preferences (cross-project)");
      for (const p of personal.slice(0, 3)) {
        lines.push(`- ${p.title}`);
      }
    }

    lines.push("");
    lines.push("Use `memory-save`, `memory-search`, and `memory-get` tools to interact with memory.");

    return {
      message: {
        customType: "memory-context",
        content: lines.join("\n"),
        display: false,
      },
    };
  });

  // ────────────────────────────────────────────────────────
  // BEFORE AGENT START — inject smart context automatically
  // ────────────────────────────────────────────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    if (!currentProject) {return;}

    // Load smart context (project-scoped)
    const contextResult = await mem("context", {
      project: currentProject,
      limit: "15",
      ...(sessionId ? { "session-id": String(sessionId) } : {}),
    });

    let crossProjectResult: MemResult | null = null;

    // If project has no memories, load cross-project context
    if (!contextResult || !((contextResult.observations as any[]) || []).length) {
      crossProjectResult = await mem("context", {
        "all-projects": "true",
        limit: "10",
        ...(sessionId ? { "session-id": String(sessionId) } : {}),
      });
    }

    if (!contextResult) {return;}

    const observations = (contextResult.observations as Array<{
      id: number; title: string; type: string; scope: string;
      topic_key: string; trust_score: number; type_priority: number;
    }>) || [];

    const personal = (contextResult.personal as Array<{
      id: number; title: string; type: string;
    }>) || [];

    const stats = contextResult.stats as { total_memories: number; total_personal: number };
    const topic = contextResult.topic as string | null;

    if (observations.length === 0 && personal.length === 0 && !crossProjectResult) {return;}

    const isNewProject = crossProjectResult !== null;
    const effectiveObservations = isNewProject
      ? ((crossProjectResult!.observations as any[]) || [])
      : observations;
    const effectiveStats = isNewProject ? crossProjectResult!.stats as any : stats;
    const effectiveProject = isNewProject ? currentProject : currentProject;

    hasInjectedContext = true;

    // Build context injection
    const topicNote = topic ? ` | topic: ${topic}` : "";
    const lines: string[] = [
      "## Memory Context (auto-loaded)",
      "",
    ];

    if (isNewProject) {
      lines.push(`Project: **${currentProject}** | 🆕 new project | ${effectiveStats?.total_memories || 0} total memories across all projects | ${stats?.total_personal || 0} personal preferences`);
      lines.push("");

      // Group cross-project memories by project
      const byProject = new Map<string, any[]>();
      for (const o of effectiveObservations) {
        const proj = o.project || "unknown";
        if (!byProject.has(proj)) {byProject.set(proj, []);}
        byProject.get(proj)!.push(o);
      }

      if (byProject.size > 0) {
        lines.push("### 🔗 Related memories from other projects");
        for (const [proj, mems] of byProject) {
          lines.push(`**${proj}** (${mems.length} memories)`);
          for (const m of mems.slice(0, 5)) {
            const trust = m.trust_score < 0.5 ? " ⚠️" : m.trust_score < 0.7 ? " 🔎" : "";
            lines.push(`- [${m.type}] ${m.title}${trust}`);
          }
        }
        lines.push("");
      }
    } else {
      lines.push(`Project: **${currentProject}** | ${stats?.total_memories || 0} memories | ${stats?.total_personal || 0} personal preferences${topicNote}`);
      lines.push("");

      if (effectiveObservations.length > 0) {
        lines.push("### Recent Relevant Memory");
        for (const o of effectiveObservations) {
          const trust =
            o.trust_score < 0.5 ? "⚠️" :
            o.trust_score < 0.8 ? "🔎" : "";
          lines.push(`- [${o.type}] ${o.title} ${trust}`);
        }
        lines.push("");
      }
    }

    if (personal.length > 0) {
      lines.push("### Your Preferences (cross-project)");
      for (const p of personal.slice(0, 5)) {
        lines.push(`- ${p.title}`);
      }
      lines.push("");
    }

    lines.push("Use `memory-save`, `memory-search`, and `memory-get` tools to interact with memory.");

    // ── Fix #3: Stale index / missing index detection ──
    // Priority: match by path first (most precise), then fall back to name
    const repos = await getKnownRepos();
    const resolvedCwd = path.resolve(ctx.cwd);
    const cwdRepo =
      repos.find(r => resolvedCwd.startsWith(path.resolve(r.path))) ||
      repos.find(r => r.name.toLowerCase() === currentProject?.toLowerCase());
    if (!cwdRepo) {
      lines.push("");
      lines.push(`⚠️ **Code not indexed:** Project \"${currentProject}\" has no code index yet. Run \`memory-code index-repo --path ${ctx.cwd} --name ${currentProject}\` to enable memory-code analysis.`);
    } else if (isRepoStale(cwdRepo)) {
      lines.push("");
      lines.push(`📝 **Code index may be stale:** \"${cwdRepo.name}\" was indexed at ${cwdRepo.indexed_at}. Source files have been modified since. Run \`memory-code reindex-repo --repo ${cwdRepo.name}\` to update.`);
    }

    return {
      message: {
        customType: "memory-context",
        content: lines.join("\n"),
        display: false,
      },
    };
  });

  // ────────────────────────────────────────────────────────

  // ────────────────────────────────────────────────────────
  // Code exploration enforcement — hard block + partial allow
  // Forces structured analysis (memory-code) before raw file reads.
  // ────────────────────────────────────────────────────────
  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;
    const input = event.input as Record<string, unknown>;

    // Track memory tool usage — mark explored files for read enforcement
    if (toolName === "memory-code") {
      lastMemoryToolCall = Date.now();
      const file = String(input?.file || "");
      // If a specific file was analyzed, add to explored set
      if (file) {
        exploredFiles.add(file.toLowerCase());
        exploredFiles.add(path.basename(file).toLowerCase());
      }
      return; // Always allow memory-code
    }
    if (toolName.startsWith("memory-")) {
      lastMemoryToolCall = Date.now();
      return; // Always allow other memory tools
    }

    // ── Hard block: bash grep/rg/find on source code in indexed repos ───
    if (toolName === "bash" && typeof input?.command === "string") {
      const cmd = input.command as string;
      if (/\b(rg\b|grep\b|ag\b|ack\b|find\b).*\.(ts|js|tsx|jsx|py|go|rs|java)/i.test(cmd)) {
        const repos = await getKnownRepos();
        // Match by directory path first (most precise), fall back to project name
        const resolvedCwd = path.resolve(process.cwd());
        const matchedRepo =
          repos.find(r => resolvedCwd.startsWith(path.resolve(r.path))) ||
          repos.find(r => currentProject?.toLowerCase() === r.name.toLowerCase());
        if (matchedRepo) {
          return {
            block: true,
            reason: `Code search detected in indexed repo "${matchedRepo.name}". Use \`memory-code\` instead:\n` +
              `• \`memory-code outline --repo ${matchedRepo.name} --file <path>\` — file structure\n` +
              `• \`memory-code callers --repo ${matchedRepo.name} --symbol <name>\` — call hierarchy\n` +
              `• \`memory-code deps --repo ${matchedRepo.name}\` — dependency graph\n` +
              `• \`memory-code importance --repo ${matchedRepo.name}\` — hotspots & churn`,
          };
        }
        // Not indexed — soft nudge with index command
        if (nudgeCountThisSession < MAX_NUDGES_PER_SESSION) {
          nudgeCountThisSession++;
          ctx.ui.notify(
            `💡 Use \`memory-code\` for structured analysis. Index this repo first: \`memory-code index-repo\``,
            "info",
          );
        }
        return; // Allow if not indexed
      }
    }

    // ── Hard block: read on unexplored code files in indexed repos ────────
    if (toolName === "read" && typeof input?.path === "string") {
      const filePath = input.path as string;

      // Allow non-code files (configs, markdown, JSON, etc.)
      if (!isCodeFile(filePath)) {return;}

      // Allow node_modules
      if (filePath.includes("node_modules")) {return;}

      // Allow partial/targeted reads (offset or limit) — agent is editing
      if (input.offset || input.limit) {return;}

      // Resolve to absolute path for matching
      const absPath = path.resolve(filePath);

      // Find which indexed repo this file belongs to
      const repos = await getKnownRepos();
      const matchedRepo = repos.find(r =>
        absPath.toLowerCase().startsWith(`${r.path.toLowerCase()  }/`) ||
        absPath.toLowerCase() === r.path.toLowerCase()
      );

      // Not in any indexed repo — allow with nudge to index
      if (!matchedRepo) {
        if (nudgeCountThisSession < MAX_NUDGES_PER_SESSION) {
          nudgeCountThisSession++;
          ctx.ui.notify(
            `💡 This code file isn't in an indexed repo. Index it: \`memory-code index-repo\``,
            "info",
          );
        }
        return; // Allow
      }

      // Check if file has been explored via memory-code
      const basename = path.basename(filePath).toLowerCase();
      const relPath = path.relative(matchedRepo.path, absPath).toLowerCase();
      if (exploredFiles.has(basename) || exploredFiles.has(relPath) || exploredFiles.has(absPath.toLowerCase())) {
        return; // Already explored — allow read for editing
      }

      // HARD BLOCK: code file in indexed repo, not yet explored
      return {
        block: true,
        reason: `Use \`memory-code\` first to understand "${path.basename(filePath)}" before reading it:\n` +
          `• \`memory-code outline --repo ${matchedRepo.name} --file ${relPath || path.basename(filePath)}\` — file structure & symbols\n` +
          `• \`memory-code callers --repo ${matchedRepo.name} --symbol <name>\` — who calls what\n` +
          `• \`memory-code deps --repo ${matchedRepo.name}\` — dependency graph\n` +
          `After reviewing the outline, use \`read\` with \`offset\`/\`limit\` for targeted editing.`,
      };
    }
  });

  // ────────────────────────────────────────────────────────
  // Fix #7: CONTEXT EVENT — lightweight persistent memory reminder
  // After compaction or in long sessions, the LLM may forget memory tools
  // Exist. This injects a minimal reminder every Nth LLM call, but only
  // If no memory tool was used recently (to avoid redundancy).
  // ────────────────────────────────────────────────────────
  pi.on("context", async (event, _ctx) => {
    llmCallCount++;

    // Don't inject if context was already injected this turn
    // (before_agent_start already loaded full context)
    if (hasInjectedContext) {
      hasInjectedContext = false;
      return;
    }

    // Only inject every Nth call
    if (llmCallCount % MEMORY_REMINDER_INTERVAL !== 0) {return;}

    // Don't inject if memory tool was used recently (within 3 min)
    if (Date.now() - lastMemoryToolCall < 180000) {return;}

    // Inject a lightweight reminder
    return {
      messages: [
        ...event.messages,
        {
          role: "user" as const,
          content: "💡 Memory reminder: Use `memory-search` before decisions to avoid repeating past mistakes. Use `memory-save` for decisions, bugfixes, and discoveries.",
        },
      ],
    };
  });

  // ────────────────────────────────────────────────────────
  // TOOL RESULT — auto-detect saveable events + git trust sync
  // ────────────────────────────────────────────────────────
  pi.on("tool_result", async (event, ctx) => {
    // Auto-save when files are edited — record what changed
    if (event.toolName === "edit" || event.toolName === "write") {
      const input = event.input as { path?: string };
      if (!input?.path || !currentProject) {return;}

      // Don't auto-save edits to the memory layer itself
      if (input.path.includes("memory-store.js") || input.path.includes("memory-layer")) {return;}

      // Track edited files for session summary
      editedFiles.add(input.path);

      // Only auto-save occasionally to avoid noise — every 5th file edit
      memoriesSavedThisSession++;
      if (memoriesSavedThisSession % 5 !== 0) {return;}

      await mem("save", {
        title: `Edited ${path.basename(input.path)}`,
        type: "accomplished",
        project: currentProject,
        scope: "project",
        force: "true",
        content: `**What**: File edited during session\n**Where**: ${input.path}`,
      });
    }

    // Fix #7: Git-triggered trust sync — after git pull/checkout/merge/rebase,
    // Code symbols may have changed. Auto-sync trust scores.
    if (event.toolName === "bash") {
      const input = event.input as { command?: string };
      const cmd = input?.command || "";
      if (/\bgit\s+(pull|checkout|merge|rebase|reset|stash\s+pop)\b/.test(cmd) && currentProject) {
        const repos = await getKnownRepos();
        const repo = repos.find(r =>
          r.name.toLowerCase() === currentProject.toLowerCase()
        );
        if (repo) {
          // Best-effort trust sync — don't block or fail on error
          mem("sync-code-trust", {
            repo: repo.name,
            "changed-symbols-json": "{}",
          }).catch(() => {});
          ctx.ui.notify(`🔄 Memory: syncing trust scores after git operation on ${repo.name}`, "info");
        }
      }
    }
  });

  // ────────────────────────────────────────────────────────
  // Fix #2: DECISION AUTO-DETECTION — detect decision/bugfix/architecture
  // Patterns in assistant messages and auto-save them as memories.
  // ────────────────────────────────────────────────────────
  const DECISION_PATTERNS: Array<{ regex: RegExp; type: string; label: string }> = [
    // Architecture/design decisions
    { regex: /\b(I['']ll use|let's use|we should use|going with|switching to|using .* instead of)\b/i, type: "decision", label: "Design decision" },
    { regex: /\b(approach|strategy|architecture|pattern|design):\s/i, type: "decision", label: "Architecture choice" },
    // Bugfix discoveries
    { regex: /\b(root cause|the bug was|issue is|problem is|fix is|fixed by|workaround is)\b/i, type: "bugfix", label: "Bug fix" },
    // Pattern discoveries
    { regex: /\b(I discovered|turns out|found that|interesting:|note that)\b/i, type: "discovery", label: "Discovery" },
    // Constraint/requirement identification
    { regex: /\b(we need to|cannot|constraint|requirement|limitation is)\b/i, type: "architecture", label: "Constraint identified" },
  ];

  // Extract text content from a message (handles both string and content array)
  function extractMessageText(msg: any): string {
    if (!msg) {return "";}
    if (typeof msg.content === "string") {return msg.content;}
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text || "")
        .join(" ");
    }
    return "";
  }

  pi.on("message_end", async (event, _ctx) => {
    if (event.message?.role !== "assistant") {return;}
    const text = extractMessageText(event.message);
    if (!text || text.length < 50) {return;} // Skip very short messages

    // Don't auto-save if already saved a decision recently (cooldown)
    if (Date.now() - lastAutoDecisionSave < AUTO_DECISION_COOLDOWN) {return;}

    // Skip messages that already involve memory tools
    if (text.includes("memory-save") || text.includes("memory-search") || text.includes("memory-get")) {return;}

    // Check for decision patterns
    for (const pattern of DECISION_PATTERNS) {
      if (pattern.regex.test(text)) {
        lastAutoDecisionSave = Date.now();

        // Extract a meaningful title from the matched text
        const firstLine = text.split("\n")[0].slice(0, 120);
        const title = `${pattern.label}: ${firstLine.slice(0, 80)}`;

        await mem("save", {
          title,
          type: pattern.type,
          project: currentProject || "unknown",
          scope: "project",
          force: "true",
          content: [
            `**What**: Auto-detected ${pattern.label.toLowerCase()}`,
            `**Where**: Session ${sessionId || "unknown"}`,
            `**Learned**: ${text.slice(0, 300)}`,
          ].join("\n"),
        });
        break; // Only save once per message
      }
    }
  });

  // ────────────────────────────────────────────────────────
  // Fix #4: PERIODIC PROGRESS CHECKPOINT — save a checkpoint every N turns
  // So long sessions don't lose all progress if interrupted.
  // ────────────────────────────────────────────────────────
  pi.on("turn_end", async (_event, _ctx) => {
    turnCount++;
    if (turnCount % CHECKPOINT_INTERVAL !== 0 || turnCount === 0) {return;}
    if (!currentProject) {return;}

    const summaryFiles = [...editedFiles].slice(0, 10).map(f =>
      `- ${path.basename(f)}`).join("\n");

    await mem("save", {
      title: `Progress checkpoint (turn ${turnCount})`,
      type: "progress",
      project: currentProject,
      scope: "project",
      force: "true",
      content: [
        `**What**: Auto-checkpoint at turn ${turnCount}`,
        `**Where**: Session ${sessionId}`,
        `**Learned**: ${memoriesSavedThisSession} explicit memories saved, ${editedFiles.size} files edited`,
        summaryFiles ? `Files touched:\n${summaryFiles}` : "",
      ].join("\n"),
    });
  });

  // ────────────────────────────────────────────────────────
  // SESSION SHUTDOWN — auto-save rich summary + close
  // ────────────────────────────────────────────────────────
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!sessionId || !currentProject) {return;}

    // Build a rich summary from the session content
    const entries = ctx.sessionManager.getEntries();
    const userMessages = entries.filter(
      (e: any) => e.type === "message" && e.message?.role === "user",
    );
    const assistantMessages = entries.filter(
      (e: any) => e.type === "message" && e.message?.role === "assistant",
    );

    // Extract unique topics from user messages
    const topics: string[] = [];
    for (const m of userMessages) {
      const text = extractMessageText((m as any).message);
      if (text) {
        const firstSentence = text.split(/[.!?\n]/)[0].slice(0, 100);
        if (firstSentence && !topics.includes(firstSentence)) {
          topics.push(firstSentence);
        }
      }
    }

    const summaryParts: string[] = [
      "## Goal",
      userMessages.length > 0
        ? (userMessages[0] as any).message?.content?.[0]?.text?.slice(0, 200) || "Session work"
        : "Session work",
      "",
      "## Topics Discussed",
      ...topics.slice(0, 10).map(t => `- ${t}`),
    ];

    if (editedFiles.size > 0) {
      summaryParts.push("", "## Files Modified");
      for (const f of [...editedFiles].slice(0, 20)) {
        summaryParts.push(`- ${path.relative(process.cwd(), f) || f}`);
      }
    }

    summaryParts.push(
      "",
      "## Accomplished",
      `${memoriesSavedThisSession} memories saved, ${assistantMessages.length} assistant turns, ${turnCount} total turns`,
    );

    await mem("session-summary", {
      content: summaryParts.join("\n"),
      project: currentProject,
    });

    await mem("session-end", {
      id: String(sessionId),
      memories: String(memoriesSavedThisSession),
      auto: "true",
    });

    if (ctx.hasUI) {
      ctx.ui.notify(`Memory: session saved (${memoriesSavedThisSession} memories, ${turnCount} turns)`, "info");
    }
  });

  // ────────────────────────────────────────────────────────
  // ── Formatting helpers for memory-code / memory-doc ──

  function formatCodeResult(mode: string, result: any): string {
    switch (mode) {
      case "callers":
      case "callees": {
        const items = result.callers || result.callees || [];
        const dir = mode === "callers" ? "Callers of" : "Callees from";
        const lines = items.map((c: any) =>
          `  [depth ${c.depth}] ${c.name} (${c.file_path})`
        );
        return `**${dir} ${result.symbol}:**\n${lines.length ? lines.join("\n") : "(none found)"}`;
      }
      case "blast-radius": {
        const aFiles = result.affected_files || [];
        const callers = result.callers || [];
        const importers = result.file_importers || [];
        return [
          `**Blast radius of ${result.symbol}** (${result.file})`,
          `Affected files: ${aFiles.length}`,
          callers.length ? `\nCallers:\n${callers.map((c: any) => `  [depth ${c.depth}] ${c.name} (${c.file_path})`).join("\n")}` : "",
          importers.length ? `\nFile importers:\n${importers.map((f: any) => `  [depth ${f.depth}] ${f.path}`).join("\n")}` : "",
        ].filter(Boolean).join("\n");
      }
      case "dead-code": {
        const deadFiles = result.dead_files || [];
        const deadSyms = result.dead_symbols || [];
        return [
          `**Dead code analysis** — ${deadFiles.length} dead files, ${deadSyms.length} dead symbols`,
          deadFiles.length ? `Dead files:\n${deadFiles.map((f: any) => `  ${f.path}`).join("\n")}` : "",
          deadSyms.slice(0, 20).map((s: any) => `  [${s.confidence}] ${s.name} (${s.file}) — ${s.signals.join(', ')}`).join("\n"),
        ].filter(Boolean).join("\n");
      }
      case "complexity": {
        if (Array.isArray(result)) {
          const high = result.filter((r: any) => r.assessment === 'high');
          const med = result.filter((r: any) => r.assessment === 'medium');
          return [
            `**Complexity:** ${result.length} functions — ${high.length} high, ${med.length} medium, ${result.length - high.length - med.length} low`,
            ...high.slice(0, 10).map((r: any) => `  🔴 ${r.name} (${r.file_path?.split('/').pop()}): cyclomatic=${r.cyclomatic} nesting=${r.nesting_depth}`),
            ...med.slice(0, 5).map((r: any) => `  🟡 ${r.name}: cyclomatic=${r.cyclomatic}`),
          ].join("\n");
        }
        return `**${result.name}** (${result.file_path?.split('/').pop()}): cyclomatic=${result.cyclomatic} nesting=${result.nesting_depth} params=${result.param_count} lines=${result.lines_of_code} — ${result.assessment}`;
      }
      case "deps": {
        const edges = result.edges || [];
        const down = result.downstream || [];
        const up = result.upstream || [];
        if (down.length || up.length) {
          return [
            down.length ? `**Downstream:**\n${down.map((d: any) => `  [${d.depth}] ${d.path}`).join("\n")}` : "",
            up.length ? `**Upstream:**\n${up.map((u: any) => `  [${u.depth}] ${u.path}`).join("\n")}` : "",
          ].filter(Boolean).join("\n");
        }
        return `**Import graph:** ${edges.length} edges\n${edges.slice(0, 20).map((e: any) => `  ${e.source} → ${e.target} (${e.type})`).join("\n")}`;
      }
      case "outline": {
        const outline = result;
        if (outline.classes) {
          const lines = outline.classes.map((c: any) => {
            const methods = c.methods.map((m: any) => `    ${(m.assessment ? `[${m.assessment}] ` : '')}${m.kind} ${m.name}${m.signature ? `: ${  m.signature.slice(0, 60)}` : ''}`).join("\n");
            return `  📦 ${c.name}\n${methods}`;
          });
          const standalone = (outline.standalone || []).map((s: any) => `  ${(s.assessment ? `[${s.assessment}] ` : '')}${s.kind} ${s.name}${s.signature ? `: ${  s.signature.slice(0, 60)}` : ''}`);
          return `**File outline**\n${[...lines, ...standalone].join("\n")}`;
        }
        return JSON.stringify(outline, null, 2);
      }
      case "churn": {
        if (result.error) {return `Error: ${result.error}`;}
        if (result.repo) {
          return `**${result.repo}** churn (${result.window_days}d): ${result.total_files_changed} files changed\n${(result.top_files || []).slice(0, 10).map((f: any) => `  ${f.file}: ${f.commits} commits (${f.churn_per_week}/wk)`).join("\n")}`;
        }
        return `**Churn:** ${result.commits} commits, ${result.unique_authors} authors (${result.churn_per_week}/wk)\n  First: ${result.first_seen} | Last: ${result.last_modified}`;
      }
      case "hotspots": {
        if (!result.hotspots?.length) {return "No hotspots found" + (result.note ? ` (${result.note})` : ".");}
        return result.hotspots.map((h: any, i: number) =>
          `${i+1}. **${h.name}** (${h.kind}) — ${h.file_path.split("/").pop()}\n   Risk: ${h.risk} | Score: ${h.hotspot_score} | Complexity: ${h.cyclomatic} | Commits: ${h.commits} | Churn: ${h.churn_per_week}/wk`
        ).join("\n\n");
      }
      case "cycles": {
        if (!result.cycles?.length) {return "No dependency cycles found — import graph is acyclic.";}
        return result.cycles.map((c: any, i: number) =>
          `${i+1}. **Cycle ${i+1}** (${c.size} files)\n   Files: ${c.files.map((f: string) => f.split("/").pop()).join(" → ")}\n   Edges: ${c.edges.map((e: any) => `${e.from.split("/").pop()} → ${e.to.split("/").pop()}`).join(", ")}`
        ).join("\n\n");
      }
      case "importance": {
        if (!result.importance?.length) {return "No symbols found.";}
        return `Top ${result.importance.length} of ${result.total_symbols} symbols by PageRank:\n\n${ 
          result.importance.map((s: any, i: number) =>
            `${i+1}. **${s.name}** (${s.kind}) — ${s.file_path.split("/").pop()} — PageRank: ${s.pagerank}`
          ).join("\n")}`;
      }
      case "coupling": {
        if (!result.metrics?.length) {return "No coupling data found.";}
        return result.metrics.map((m: any) => {
          const short = m.file_path.split("/").pop();
          return `**${short}** (${m.category})\n   Ca=${m.afferent} Ce=${m.efferent} I=${m.instability}`;
        }).join("\n\n");
      }
      case "extractable": {
        if (!result.candidates?.length) {return "No extraction candidates found. Try lowering --min-complexity or --min-callers.";}
        return result.candidates.map((c: any, i: number) =>
          `${i+1}. **${c.name}** (${c.kind}) — ${c.file_path.split("/").pop()}\n   Score: ${c.extraction_score} | Complexity: ${c.cyclomatic} | Callers: ${c.caller_file_count} files\n   Called from: ${c.caller_files.map((f: string) => f.split("/").pop()).join(", ")}`
        ).join("\n\n");
      }
      case "hierarchy": {
        if (result.error) {return `Error: ${result.error}`;}
        let out = `**${result.name}** (${result.kind}) — ${result.file_path.split("/").pop()}`;
        if (result.ancestors?.length) {
          out += `\n\nAncestors: ${  result.ancestors.map((a: any) => `${a.name} (${a.kind})`).join(" → ")}`;
        }
        if (result.descendants?.length) {
          out += `\n\nMembers: ${  result.descendants.map((d: any) => `${d.name} (${d.kind})`).join(", ")}`;
        }
        if (!result.ancestors?.length && !result.descendants?.length) {
          out += `\n\n(No parent classes or child members found)`;
        }
        return out;
      }
      case "signal-chains": {
        if (!result.chains?.length) {return result.note || "No signal chains found.";}
        return result.chains.map((c: any) => {
          const gw = c.gateway || c;
          const label = gw.method ? `${gw.method} ${gw.path}` : gw.name;
          return `▶ **${label}** (${gw.kind})\n${ 
            c.chain.map((s: any, i: number) => `${'  '.repeat(i + 1)}→ ${s.name} (${s.kind || 'fn'})`).join("\n")}`;
        }).join("\n\n");
      }
      case "layer-violations": {
        if (result.error) {return `Error: ${result.error}`;}
        if (result.note) {return result.note;}
        if (!result.violations?.length) {return "No layer violations found.";}
        return result.violations.map((v: any) =>
          `❌ **${v.source_layer}** → **${v.target_layer}**: ${v.source.split("/").pop()} imports ${v.target.split("/").pop()}\n   Rule: ${v.rule}`
        ).join("\n\n");
      }
      case "index-repo": {
        if (result.error) {return `Error: ${result.error}`;}
        return `✅ Repo "${result.name || result.repo}" indexed: ${result.file_count || 0} files, ${result.symbol_count || 0} symbols`;
      }
      case "reindex-repo": {
        if (result.error) {return `Error: ${result.error}`;}
        return `✅ Repo "${result.name || result.repo}" reindexed: ${result.file_count || 0} files, ${result.symbol_count || 0} symbols (${result.mode || 'incremental'})`;
      }
      case "index-docs": {
        if (result.error) {return `Error: ${result.error}`;}
        return `✅ Doc repo "${result.name || params.name}" indexed: ${result.section_count || 0} sections in ${result.file_count || 0} files`;
      }
      case "reindex-docs": {
        if (result.error) {return `Error: ${result.error}`;}
        return `✅ Doc repo "${result.name || params.repo}" reindexed: ${result.section_count || 0} sections (${result.mode || 'full'})`;
      }
      default:
        return JSON.stringify(result, null, 2).slice(0, 2000);
    }
  }

  function formatDocResult(mode: string, result: any): string {
    switch (mode) {
      case "search": {
        const items = result.results || [];
        return `**Doc search:** ${items.length} results\n${items.slice(0, 15).map((r: any) => `  [${r.role}] (L${r.level}) ${r.title} — ${r.file_path}`).join("\n")}`;
      }
      case "outline": {
        if (Array.isArray(result)) {
          const walk = (nodes: any[], indent: number) =>
            nodes.map((n: any) => `${'  '.repeat(indent)}${'#'.repeat(Math.min(n.level || 1, 6))} ${n.title} [${n.role}]\n${n.children?.length ? walk(n.children, indent + 1) : ''}`).join('');
          return walk(result, 0);
        }
        const files = result.files || [];
        return `**Docs:** ${files.length} files\n${files.map((f: any) => `  ${f.path} (${f.section_count} sections)`).join("\n")}`;
      }
      case "backlinks": {
        const bl = result.backlinks || [];
        return `**Backlinks:** ${bl.length}\n${bl.map((b: any) => `  ← ${b.source_file}#${b.source_title} ("${b.link_text}")`).join("\n")}`;
      }
      case "broken-links": {
        const bad = result.broken_links || [];
        return `**Broken links:** ${bad.length}\n${bad.slice(0, 20).map((l: any) => `  ${l.source_file}: "${l.link_text}" → ${l.target_path}`).join("\n")}`;
      }
      case "glossary": {
        if (result.error) {return result.error;}
        if (Array.isArray(result)) {
          return `**Glossary:** ${result.length} terms\n${result.slice(0, 20).map((t: any) => `  **${t.term}** — ${t.definition.slice(0, 80)}`).join("\n")}`;
        }
        return `**${result.term}** — ${result.definition}`;
      }
      case "tutorial-path": {
        const chain = result.chain || [];
        return `**Tutorial path:**\n${chain.map((c: any, i: number) => `  ${i + 1}. ${c.title} (section #${c.section_id})`).join("\n")}`;
      }
      case "code-examples": {
        const examples = result.results || [];
        return `**Code examples:** ${examples.length}\n${examples.map((e: any) => `  ${e.section_title} (${e.file_path}) [${e.lang}]:\n${e.content.slice(0, 150)}...`).join("\n\n")}`;
      }
      case "orphans": {
        if (!result.orphans?.length) {return "No orphan sections found — all sections have inbound links.";}
        return `Found ${result.total} orphan sections:\n\n${ 
          result.orphans.map((s: any) =>
            `- **${s.title}** (L${s.level}) — ${s.file_path.split("/").pop()} [${s.role || "other"}]`
          ).join("\n")}`;
      }
      case "coverage": {
        return `Doc coverage: ${result.coverage_pct}% (${result.documented}/${result.total_symbols} symbols documented)\n\n` +
          `**Documented** (showing up to 20):\n${ 
          result.documented_list.map((s: any) => `  ✅ ${s.name} (${s.kind}) — ${s.file_path.split("/").pop()}`).join("\n") 
          }\n\n**Undocumented** (showing up to 20):\n${ 
          result.undocumented_list.map((s: any) => `  ❌ ${s.name} (${s.kind}) — ${s.file_path.split("/").pop()}`).join("\n")}`;
      }
      case "stale-pages": {
        if (!result.stale?.length && !result.missing?.length) {return "No stale or missing pages found. Docs are up to date.";}
        let out = "";
        if (result.stale?.length) {
          out += `**Stale pages** (${result.stale.length} modified since index):\n${ 
            result.stale.map((s: any) => `  📝 ${s.path} (indexed: ${new Date(s.indexed_mtime).toISOString().slice(0,19)}, current: ${new Date(s.current_mtime).toISOString().slice(0,19)})`).join("\n")}`;
        }
        if (result.missing?.length) {
          if (out) {out += "\n";}
          out += `**Missing pages** (${result.missing.length} deleted since index):\n${ 
            result.missing.map((s: any) => `  🗑️ ${s.path}`).join("\n")}`;
        }
        return out;
      }
      case "duplicates": {
        if (!result.duplicates?.length) {return "No duplicate sections found.";}
        return `Found ${result.total_duplicate_groups} duplicate groups:\n\n${ 
          result.duplicates.map((d: any) =>
            `**Hash ${d.content_hash.slice(0, 8)}...** (${d.count} copies)\n` +
            d.sections.map((s: any) => `  - "${s.title}" in ${s.file_path.split("/").pop()}`).join("\n")
          ).join("\n\n")}`;
      }
      default:
        return JSON.stringify(result, null, 2).slice(0, 2000);
    }
  }

  // MEMORY TOOLS — native tools the LLM can call directly
  // ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "memory-save",
    label: "Save Memory",
    description:
      "Save an observation to persistent memory. Use for decisions, bugfixes, architecture constraints, patterns, and discoveries. " +
      "Automatically checks for duplicates. Content should use **What**/**Why**/**Where**/**Learned** format.",
    parameters: Type.Object({
      title: Type.String({ description: "Short, searchable title (e.g. 'JWT auth middleware', 'Fixed N+1 in user list')" }),
      content: Type.String({ description: "Structured content: **What**: ...\\n**Why**: ...\\n**Where**: ...\\n**Learned**: ..." }),
      type: Type.Optional(Type.String({ description: "Observation type: decision, bugfix, architecture, pattern, discovery, config, preference, learning", default: "manual" })),
      scope: Type.Optional(Type.String({ description: "Scope: 'project' (default) or 'personal' (cross-project preferences)", default: "project" })),
      topic_key: Type.Optional(Type.String({ description: "Optional topic key for grouping related observations (e.g. 'auth/jwt-middleware')" })),
      force: Type.Optional(Type.Boolean({ description: "Force save even if duplicate detected", default: false })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      memoriesSavedThisSession++;
      const result = await mem("save", {
        title: params.title,
        content: params.content,
        type: params.type || "manual",
        project: currentProject || "unknown",
        scope: params.scope || "project",
        ...(params.topic_key ? { "topic-key": params.topic_key } : {}),
        ...(params.force ? { force: "true" } : {}),
      });

      if (!result) {
        return { content: [{ type: "text", text: "Failed to save memory." }], details: {}, isError: true };
      }

      if (result.auto_merged) {
        return {
          content: [{
            type: "text",
            text: `✅ Memory saved [#${result.id}] ${result.title}\n🔄 Auto-merged: superseded older [#${result.superseded_id}] "${result.superseded_title}" (${(result.similarity * 100).toFixed(0)}% similar)`,
          }],
          details: result,
        };
      }

      if (result.status === "potential_duplicate") {
        return {
          content: [{
            type: "text",
            text: `⚠️ Potential duplicate detected:\n${(result.matches as any[]).map((m: any) => `  - [#${m.id}] ${m.title} (${m.similarity}% similar)`).join("\n")}\n\nUse force=true to save anyway.`,
          }],
          details: result,
          isError: false,
        };
      }

      return {
        content: [{ type: "text", text: `✅ Memory saved: [#${result.id}] ${result.title}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "memory-search",
    label: "Search Memory",
    description:
      "Search persistent memory for past decisions, bugfixes, patterns, and discoveries. " +
      "Results are ranked by relevance, recency, trust, and usefulness. " +
      "Always search before saving to avoid duplicates.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query — matches titles and content" }),
      type: Type.Optional(Type.String({ description: "Filter by type: decision, bugfix, architecture, pattern, discovery, config, preference" })),
      scope: Type.Optional(Type.String({ description: "Filter by scope: project, personal" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)", default: 10 })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      // Try project-scoped first, fall back to global if empty
      let result = currentProject
        ? await mem("search", {
            query: params.query,
            ...(params.type ? { type: params.type } : {}),
            ...(params.scope ? { scope: params.scope } : {}),
            ...(params.limit ? { limit: String(params.limit) } : {}),
            project: currentProject,
            ...(sessionId ? { "session-id": String(sessionId) } : {}),
          })
        : null;

      // If no project results, search globally
      if (!result || !((result.results as any[]) || []).length) {
        result = await mem("search", {
          query: params.query,
          ...(params.type ? { type: params.type } : {}),
          ...(params.scope ? { scope: params.scope } : {}),
          ...(params.limit ? { limit: String(params.limit) } : {}),
          ...(sessionId ? { "session-id": String(sessionId) } : {}),
        });
      }

      if (!result) {
        return { content: [{ type: "text", text: "Search failed." }], details: {}, isError: true };
      }

      const results = (result.results as any[]) || [];
      if (results.length === 0) {
        return { content: [{ type: "text", text: "No memories found." }], details: result };
      }

      const lines = results.map((r: any) => {
        const score = r._score ? ` (${r._score.toFixed(2)})` : "";
        const trust = r.trust_score && r.trust_score < 0.5 ? " ⚠️" : "";
        return `- [#${r.id}] [${r.type}] ${r.title}${score}${trust}${r.snippet ? `\n  ${r.snippet}` : ""}`;
      });

      return {
        content: [{ type: "text", text: `Found ${results.length} memories:\n${lines.join("\n")}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "memory-get",
    label: "Get Memory",
    description:
      "Get full details of a specific memory by ID, including content, symbol links, and recall count.",
    parameters: Type.Object({
      id: Type.Number({ description: "Memory observation ID" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const result = await mem("get", { id: String(params.id) });
      if (!result || result.error) {
        return { content: [{ type: "text", text: `Memory #${params.id} not found.` }], details: {}, isError: true };
      }
      return {
        content: [{ type: "text", text: `## #${result.id} — ${result.title}\nType: ${result.type} | Scope: ${result.scope} | Project: ${result.project}\n\n${result.content}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "memory-update",
    label: "Update Memory",
    description:
      "Update an existing memory in-place by ID. Use when you need to correct or refine a previously saved memory " +
      "instead of creating a duplicate or correction entry. Updates only the fields you provide.",
    parameters: Type.Object({
      id: Type.Number({ description: "Memory observation ID to update" }),
      title: Type.Optional(Type.String({ description: "New title (optional)" })),
      content: Type.Optional(Type.String({ description: "New content (optional). Use **What**/**Why**/**Where**/**Learned** format." })),
      type: Type.Optional(Type.String({ description: "New type: decision, bugfix, architecture, pattern, discovery, config, preference, learning" })),
      scope: Type.Optional(Type.String({ description: "New scope: project or personal" })),
      topic_key: Type.Optional(Type.String({ description: "New topic key (optional)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const args: Record<string, string> = { id: String(params.id) };
      if (params.title) {args.title = params.title;}
      if (params.content) {args.content = params.content;}
      if (params.type) {args.type = params.type;}
      if (params.scope) {args.scope = params.scope;}
      if (params.topic_key) {args["topic-key"] = params.topic_key;}

      const result = await mem("update", args);
      if (!result || result.error) {
        return { content: [{ type: "text", text: `Failed to update memory #${params.id}: ${result?.error || "unknown error"}` }], details: {}, isError: true };
      }
      return {
        content: [{ type: "text", text: `✅ Memory updated: [#${result.id}] ${result.title}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "memory-delete",
    label: "Delete Memory",
    description:
      "Soft-delete a memory by ID. Use to remove stale, incorrect, or duplicate memories. " +
      "The memory is soft-deleted (can be recovered) rather than permanently destroyed.",
    parameters: Type.Object({
      id: Type.Number({ description: "Memory observation ID to delete" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const result = await mem("delete", { id: String(params.id) });
      if (!result || result.error) {
        return { content: [{ type: "text", text: `Failed to delete memory #${params.id}: ${result?.error || "unknown error"}` }], details: {}, isError: true };
      }
      return {
        content: [{ type: "text", text: `🗑️ Memory #${params.id} deleted${result.hardDeleted ? " (hard)" : " (soft)"}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "memory-related",
    label: "Find Related Memories",
    description:
      "Find memories linked to the same code symbols as a given memory. " +
      "Use when you want to understand the full context around a topic.",
    parameters: Type.Object({
      id: Type.Number({ description: "Memory ID to find related memories for" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const result = await mem("related", { id: String(params.id) });
      if (!result) {
        return { content: [{ type: "text", text: "Failed to find related memories." }], details: {}, isError: true };
      }
      const related = (result.related as any[]) || [];
      if (related.length === 0) {
        return { content: [{ type: "text", text: "No related memories found." }], details: result };
      }
      const lines = related.flatMap((r: any) => [
        `### ${r.symbol}`,
        ...r.memories.map((m: any) => `- [#${m.id}] [${m.type}] ${m.title}`),
      ]);
      return {
        content: [{ type: "text", text: `Related memories for #${params.id}:\n${lines.join("\n")}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "memory-load-context",
    label: "Load Topic Context",
    description:
      "Load deeper memory context for a specific topic or query. " +
      "Use this when you need everything the memory layer knows about a specific domain " +
      "(e.g., 'xRDP audio', 'benchmark pipeline', 'GPU setup'). " +
      "Returns more memories than the auto-loaded context, focused on the topic.",
    parameters: Type.Object({
      query: Type.String({ description: "Topic or keyword to load context for (e.g. 'xrdp', 'benchmark', 'auth')" }),
      deep: Type.Optional(Type.Boolean({ description: "Load deeper (up to 3x more memories). Default false.", default: false })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!currentProject) {
        return { content: [{ type: "text", text: "No project detected — can't load context." }], details: {}, isError: true };
      }
      const result = await mem("context", {
        project: currentProject,
        query: params.query,
        limit: "30",
        deep: params.deep ? "true" : "false",
        ...(sessionId ? { "session-id": String(sessionId) } : {}),
      });

      if (!result) {
        return { content: [{ type: "text", text: "Failed to load context." }], details: {}, isError: true };
      }

      const observations = (result.observations as any[]) || [];
      if (observations.length === 0) {
        return { content: [{ type: "text", text: `No memories found for topic "${params.query}".` }], details: result };
      }

      const lines = observations.map((o: any) => {
        const trust = trustIcon(o.trust_score);
        return `- [#${o.id}] [${o.type}] ${o.title}${trust}`;
      });

      return {
        content: [{
          type: "text",
          text: `## Topic Context: "${params.query}"\n**${result.stats.total_memories}** total memories in **${currentProject}**, showing ${observations.length} matching "${params.query}":\n\n${lines.join("\n")}`,
        }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "memory-sync-code-trust",
    label: "Sync Trust w/ Code Changes",
    description:
      "Synchronize memory trust scores with code changes detected by jCodeMunch. " +
      "Pipe the output of jcodemunch_get_changed_symbols to auto-adjust trust: " +
      "memories linked to changed symbols lose trust (-0.3), unchanged ones gain (+0.05). " +
      "Run this after a git pull, branch switch, or major code change to keep memory accurate.",
    parameters: Type.Object({
      repo: Type.String({ description: "jCodeMunch repo identifier for symbol lookups" }),
      changed_symbols_json: Type.String({ description: "JSON output from jcodemunch_get_changed_symbols (the raw result object, stringified)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const result = await mem("sync-code-trust", {
        repo: params.repo,
        "changed-symbols-json": params.changed_symbols_json,
      });

      if (!result) {
        return { content: [{ type: "text", text: "Failed to sync trust scores." }], details: {}, isError: true };
      }

      const lines: string[] = [];
      if ((result.adjusted as any[])?.length) {
        lines.push(`### ⚠️ Trust reduced (symbols changed): ${result.adjusted.length}`);
        (result.adjusted as any[]).forEach((a: any) => {
          lines.push(`- memory #${a.memory_id} (symbol: ${a.symbol_id}): ${a.old_trust} → ${a.new_trust}`);
        });
      }
      if ((result.survived as any[])?.length) {
        lines.push(`\n### ✅ Trust increased (symbols survived): ${result.survived.length}`);
        (result.survived as any[]).slice(0, 10).forEach((s: any) => {
          lines.push(`- memory #${s.memory_id}: ${s.old_trust} → ${s.new_trust}`);
        });
      }
      if ((result.unchanged as any[])?.length) {
        lines.push(`\n### 🔒 Unchanged (already max trust): ${result.unchanged.length}`);
      }

      lines.push(`\n**Total links checked:** ${result.total}`);

      return {
        content: [{ type: "text", text: lines.join("\n") || "No changes detected." }],
        details: result,
      };
    },
  });

  // ────────────────────────────────────────────────────────
  // COMMANDS
  // ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "memory-code",
    label: "Code Analysis",
    description:
      "Analyze code in indexed repos — import graphs, call hierarchies, blast radius, dead code, complexity, hotspots, cycles, " +
      "importance, coupling, extraction candidates, class hierarchy, file outlines, churn, and signal chains. " +
      "Requires the repo to be indexed first (use mode `index-repo`). " +
      "Modes: callers, callees, blast-radius, dead-code, complexity, deps, outline, churn, hotspots, cycles, importance, coupling, extractable, hierarchy, signal-chains, layer-violations, index-repo, reindex-repo.",
    parameters: Type.Object({
      mode: Type.String({
        description: "Analysis mode: callers|callees|blast-radius|dead-code|complexity|deps|outline|churn|hotspots|cycles|importance|coupling|extractable|hierarchy|signal-chains|layer-violations|index-repo|reindex-repo",
        enum: ["callers", "callees", "blast-radius", "dead-code", "complexity", "deps", "outline", "churn", "hotspots", "cycles", "importance", "coupling", "extractable", "hierarchy", "signal-chains", "layer-violations", "index-repo", "reindex-repo"],
      }),
      repo: Type.String({ description: "Indexed repo name" }),
      symbol: Type.Optional(Type.String({ description: "Symbol name (required for callers, callees, blast-radius, complexity)" })),
      file: Type.Optional(Type.String({ description: "File path (required for outline, churn; optional for deps)" })),
      depth: Type.Optional(Type.Number({ description: "Graph traversal depth 1-5 (default 3)", default: 3 })),
      direction: Type.Optional(Type.String({ description: "Import direction for deps: imports|importers|both", default: "both" })),
      min_confidence: Type.Optional(Type.Number({ description: "Min confidence for dead-code (0-1, default 0.5)", default: 0.5 })),
      days: Type.Optional(Type.Number({ description: "Churn/hotspot lookback window in days (default 90)", default: 90 })),
      refresh: Type.Optional(Type.Boolean({ description: "Force refresh churn cache", default: false })),
      top: Type.Optional(Type.Number({ description: "Max results (default 20)", default: 20 })),
      scope: Type.Optional(Type.String({ description: "Scope importance to subdirectory (e.g. 'src/core')" })),
      sort_by: Type.Optional(Type.String({ description: "Sort coupling by: instability|afferent|efferent", default: "instability" })),
      min_complexity: Type.Optional(Type.Number({ description: "Min cyclomatic complexity for extractable (default 5)", default: 5 })),
      min_callers: Type.Optional(Type.Number({ description: "Min caller files for extractable (default 2)", default: 2 })),
      direction_hier: Type.Optional(Type.String({ description: "Hierarchy direction: both|ancestors|descendants", default: "both" })),
      kind: Type.Optional(Type.String({ description: "Gateway kind: http, cli, or omit for all" })),
      symbol_chain: Type.Optional(Type.String({ description: "Trace which signal chain a symbol participates in" })),
      path: Type.Optional(Type.String({ description: "Local path to repo directory (required for index-repo mode)" })),
      name: Type.Optional(Type.String({ description: "Repo name for indexing (defaults to directory basename)" })),
      rules: Type.Optional(Type.String({ description: "JSON layer rules config (or use .pimemory-layers.jsonc file)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const cmdMap: Record<string, string> = {
        callers: "call-hierarchy",
        callees: "call-hierarchy",
        "blast-radius": "blast-radius",
        "dead-code": "dead-code",
        complexity: "complexity",
        deps: "import-graph",
        outline: "outline",
        churn: "churn",
        hotspots: "hotspots",
        cycles: "cycles",
        importance: "importance",
        coupling: "coupling",
        extractable: "extractable",
        hierarchy: "hierarchy",
        "signal-chains": "signal-chains",
        "layer-violations": "layer-violations",
        "index-repo": "index-repo",
        "reindex-repo": "reindex-repo",
      };
      const cmd = cmdMap[params.mode];
      if (!cmd) {return { content: [{ type: "text", text: `Unknown mode: ${params.mode}` }], details: {}, isError: true };}

      const args: Record<string, string> = { repo: params.repo };
      if (params.symbol) {args.symbol = params.symbol;}
      if (params.file) {args.file = params.file;}
      if (params.depth) {args.depth = String(params.depth);}
      if (params.direction) {args.direction = params.direction;}
      if (cmd === "call-hierarchy") {args.direction = params.mode === "callers" ? "callers" : "callees";}
      if (params.min_confidence) {args["min-confidence"] = String(params.min_confidence);}
      if (params.days) {args.days = String(params.days);}
      if (params.refresh) {args.refresh = "true";}
      if (params.top) {args.top = String(params.top);}
      if (params.scope) {args.scope = params.scope;}
      if (params.sort_by) {args["sort-by"] = params.sort_by;}
      if (params.min_complexity) {args["min-complexity"] = String(params.min_complexity);}
      if (params.min_callers) {args["min-callers"] = String(params.min_callers);}
      if (params.direction_hier) {args.direction = params.direction_hier;}
      if (params.kind) {args.kind = params.kind;}
      if (params.symbol_chain) {args.symbol = String(params.symbol_chain);}
      if (params.path) {args.path = params.path;}
      if (params.name) {args.name = params.name;}
      if (params.rules) {args.rules = typeof params.rules === "string" ? params.rules : JSON.stringify(params.rules);}

      // Skip repo check for indexing modes — they CREATE the repo entry
      if (params.mode === "index-repo" || params.mode === "reindex-repo") {
        const result = await mem(cmd, args);
        if (!result) {return { content: [{ type: "text", text: "Indexing failed or timed out." }], details: {}, isError: true };}
        if (result.error) {return { content: [{ type: "text", text: `Error: ${result.error}` }], details: result, isError: true };}
        const fmt = formatCodeResult(params.mode, result);
        return { content: [{ type: "text", text: fmt }], details: result };
      }

      // Fix #1: Check if repo is indexed before running analysis
      const codeRepos = await getKnownRepos();
      const repoMatch = codeRepos.find(r => r.name.toLowerCase() === params.repo.toLowerCase());
      if (!repoMatch) {
        const available = codeRepos.map(r => r.name).join(", ") || "none";
        const cwd = process.cwd();
        return {
          content: [{ type: "text", text: `❌ Repo \"${params.repo}\" is not indexed. Available repos: ${available}\n\nTo index this repo, run:\n\`memory-code index-repo --path ${cwd} --name ${params.repo}\`` }],
          details: {},
          isError: true,
        };
      }

      const result = await mem(cmd, args);
      if (!result) {
        if (cmd === "dead-code" || cmd === "cycles" || cmd === "importance" || cmd === "coupling" || cmd === "signal-chains" || cmd === "import-graph") {
          return { content: [{ type: "text", text: `Analysis timed out or failed for \"${params.mode}\". Try reducing scope or depth, or re-index the repo.\nCommand: ${cmd} on repo \"${params.repo}\"` }], details: {}, isError: true };
        }
        return { content: [{ type: "text", text: "Analysis failed." }], details: {}, isError: true };
      }
      if (result.error) {return { content: [{ type: "text", text: `Error: ${result.error}` }], details: result, isError: true };}

      // Format based on mode
      const fmt = formatCodeResult(params.mode, result);
      return { content: [{ type: "text", text: fmt }], details: result };
    },
  });

  pi.registerTool({
    name: "memory-doc",
    label: "Doc Index",
    description:
      "Search and query indexed documentation — full-text search, outlines, backlinks, broken links, glossary terms, tutorial paths, code examples, and stale page detection. " +
      "Requires docs to be indexed first (use mode `index-docs`). " +
      "Modes: search, outline, backlinks, broken-links, glossary, tutorial-path, code-examples, orphans, coverage, stale-pages, duplicates, index-docs, reindex-docs.",
    parameters: Type.Object({
      mode: Type.String({
        description: "Query mode: search|outline|backlinks|broken-links|glossary|tutorial-path|code-examples|orphans|coverage|stale-pages|duplicates|index-docs|reindex-docs",
        enum: ["search", "outline", "backlinks", "broken-links", "glossary", "tutorial-path", "code-examples", "orphans", "coverage", "stale-pages", "duplicates", "index-docs", "reindex-docs"],
      }),
      repo: Type.String({ description: "Indexed doc repo name" }),
      query: Type.Optional(Type.String({ description: "Search query (required for search, code-examples)" })),
      file: Type.Optional(Type.String({ description: "Doc file path (optional for outline)" })),
      doc_path: Type.Optional(Type.String({ description: "Doc file path (for backlinks, required)" })),
      term: Type.Optional(Type.String({ description: "Glossary term to look up (optional)" })),
      section: Type.Optional(Type.Number({ description: "Section ID for tutorial-path" })),
      level: Type.Optional(Type.Number({ description: "Heading level filter for search" })),
      role: Type.Optional(Type.String({ description: "Role filter for search: concept, tutorial, how_to, api, example, troubleshooting, faq" })),
      lang: Type.Optional(Type.String({ description: "Language filter for code-examples (e.g. 'js', 'python')" })),
      include_same_doc: Type.Optional(Type.Boolean({ description: "Include intra-document links when finding orphans (default: false)" })),
      doc_repo: Type.Optional(Type.String({ description: "Code repo name for coverage mode. Defaults to repo." })),
      path: Type.Optional(Type.String({ description: "Local path to docs directory (required for index-docs mode)" })),
      name: Type.Optional(Type.String({ description: "Doc repo name (required for index-docs mode)" })),
      ignore: Type.Optional(Type.String({ description: "Glob pattern to ignore during doc indexing" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const cmdMap: Record<string, string> = {
        search: "doc-search",
        outline: "doc-outline",
        backlinks: "backlinks",
        "broken-links": "broken-links",
        glossary: "glossary",
        "tutorial-path": "tutorial-path",
        "code-examples": "code-examples",
        orphans: "doc-orphans",
        coverage: "doc-coverage",
        "stale-pages": "stale-pages",
        "duplicates": "doc-duplicates",
        "index-docs": "index-docs",
        "reindex-docs": "reindex-docs",
      };
      const cmd = cmdMap[params.mode];
      if (!cmd) {return { content: [{ type: "text", text: `Unknown mode: ${params.mode}` }], details: {}, isError: true };}

      const args: Record<string, string> = { repo: params.repo };
      if (params.query) {args.query = params.query;}
      if (params.file) {args.file = params.file;}
      if (params.doc_path) {args.path = params.doc_path;}
      if (params.term) {args.term = params.term;}
      if (params.section) {args.section = String(params.section);}
      if (params.level) {args.level = String(params.level);}
      if (params.role) {args.role = params.role;}
      if (params.lang) {args.lang = params.lang;}
      if (params.include_same_doc) {args["include-same-doc"] = "true";}
      if (params.doc_repo) {args["doc-repo"] = params.doc_repo;}
      if (params.path) {args.path = params.path;}
      if (params.name) {args.name = params.name;}
      if (params.ignore) {args.ignore = params.ignore;}

      // Skip doc repo check for indexing modes — they CREATE the repo entry
      if (params.mode === "index-docs" || params.mode === "reindex-docs") {
        const result = await mem(cmd, args);
        if (!result) {return { content: [{ type: "text", text: "Doc indexing failed or timed out." }], details: {}, isError: true };}
        if (result.error) {return { content: [{ type: "text", text: `Error: ${result.error}` }], details: result, isError: true };}
        const fmt = formatDocResult(params.mode, result);
        return { content: [{ type: "text", text: fmt }], details: result };
      }

      // Fix #1: Check if doc repo is indexed before running doc query
      const docRepos = await getKnownRepos();
      const docRepoMatch = docRepos.find(r => r.name.toLowerCase() === params.repo.toLowerCase());
      if (!docRepoMatch) {
        const available = docRepos.map(r => r.name).join(", ") || "none";
        const cwd = process.cwd();
        return {
          content: [{ type: "text", text: `❌ Doc repo \"${params.repo}\" is not indexed. Available repos: ${available}\n\nTo index these docs, run:\n\`memory-doc index-docs --path ${cwd} --name ${params.repo}\`` }],
          details: {},
          isError: true,
        };
      }

      const result = await mem(cmd, args);
      if (!result) {return { content: [{ type: "text", text: "Doc query failed." }], details: {}, isError: true };}
      if (result.error) {return { content: [{ type: "text", text: `Error: ${result.error}` }], details: result, isError: true };}

      const fmt = formatDocResult(params.mode, result);
      return { content: [{ type: "text", text: fmt }], details: result };
    },
  });

  pi.registerCommand("memory-stats", {
    description: "Show memory layer statistics",
    handler: async (_args, ctx) => {
      const result = await memCmd("stats");
      if (result) {
        ctx.ui.notify(
          `🧠 ${result.total_observations} observations | ${result.total_sessions} sessions | ${result.total_symbol_links} symbol links`,
          "info",
        );
      }
    },
  });

  pi.registerCommand("memory-dream", {
    description: "Manually trigger the Dream Cycle — clean stale (not just old) memories",
    handler: async (_args, ctx) => {
      try {
        const result = await memCmd("dream");
        if (result) {
          const phases = Object.entries((result as any).phases || {})
            .filter(([k, v]) => k !== "compact" && (v as any).count > 0)
            .map(([k, v]) => `${k}: ${(v as any).count}`)
            .join(", ");
          ctx.ui.notify(
            `💤 Dream Cycle complete: ${(result as any).totalCleaned} memories cleaned (${phases || 'nothing to clean'})`,
            "info",
          );
        }
      } catch (e) {
        ctx.ui.notify(`Dream Cycle failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.registerCommand("memory-context", {
    description: "Reload memory context for current project",
    handler: async (_args, ctx) => {
      if (!currentProject) {
        ctx.ui.notify("No project detected", "error");
        return;
      }
      const result = await mem("context", { project: currentProject, limit: "10" });
      if (result) {
        const obs = (result.observations as any[]) || [];
        ctx.ui.notify(
          `🧠 ${obs.length} observations loaded for ${currentProject}`,
          "info",
        );
      }
    },
  });
}
