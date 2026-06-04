import { mem, memCmd } from '../host/memory-client';
import { state, trustIcon } from '../state';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from './schema';
import { normalizeToolResult } from './tool-result';
import { renderCompactToolResult } from './render';

interface MemoryDeps {
  state: typeof state;
  mem: typeof mem;
  memCmd: typeof memCmd;
  trustIcon: typeof trustIcon;
}

export function registerMemoryTools(pi: ExtensionAPI, deps: MemoryDeps) {
  pi.registerTool({
    name: 'memory-save',
    label: 'Save Memory',
    description: 'Save persistent memory; checks duplicates. Use What/Why/Where/Learned content.',
    parameters: Type.Object({
      title: Type.String({ description: 'Short searchable title' }),
      content: Type.String({ description: 'What/Why/Where/Learned content' }),
      type: Type.Optional(
        Type.String({
          description: 'decision|bugfix|architecture|pattern|discovery|config|preference|learning',
          default: 'manual',
        }),
      ),
      scope: Type.Optional(
        Type.String({
          description: 'project|personal',
          default: 'project',
        }),
      ),
      topic_key: Type.Optional(
        Type.String({
          description: 'Optional topic key',
        }),
      ),
      force: Type.Optional(Type.Boolean({ description: 'Bypass duplicate warning', default: false })),
      expires_in: Type.Optional(
        Type.String({
          description: 'Optional TTL duration (e.g., "7d", "2w", "1m", "12h"). Memory auto-expires after this period.',
        }),
      ),
    }),
    renderResult: renderCompactToolResult,
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        deps.state.memoriesSavedThisSession++;
        const result = await deps.mem('save', {
          title: params.title,
          content: params.content,
          type: params.type || 'manual',
          project: deps.state.currentProject || 'unknown',
          scope: params.scope || 'project',
          ...(params.topic_key ? { 'topic-key': params.topic_key } : {}),
          ...(params.force ? { force: 'true' } : {}),
          ...(params.expires_in ? { 'expires-in': params.expires_in } : {}),
        });

        if (!result) {
          return { content: [{ type: 'text', text: 'Failed to save memory.' }], details: {}, isError: true };
        }

        if (result.auto_merged) {
          const sim = result.similarity != null ? (result.similarity * 100).toFixed(0) : '?';
          return {
            content: [
              {
                type: 'text',
                text:
                  `✅ Memory saved [#${result.id}] ${result.title}\n` +
                  `🔄 Auto-merged: superseded older [#${result.superseded_id}] "${result.superseded_title ?? ''}" (${sim}% similar)` +
                  (result.expires_at ? `\n⏰ Expires: ${result.expires_at}` : ''),
              },
            ],
            details: result ?? {},
          };
        }

        if (result.status === 'potential_duplicate') {
          const matches = (result.matches as any[]) || [];
          return {
            content: [
              {
                type: 'text',
                text: `⚠️ Potential duplicate detected:\n${matches.map((m: any) => `  - [#${m.id}] ${m.title} (${m.similarity}% similar)`).join('\n')}\n\nUse force=true to save anyway.`,
              },
            ],
            details: result ?? {},
            isError: false,
          };
        }

        return {
          content: [
            {
              type: 'text',
              text:
                `✅ Memory saved: [#${result.id}] ${result.title}` +
                (result.expires_at ? `\n⏰ Expires: ${result.expires_at}` : ''),
            },
          ],
          details: result ?? {},
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Unexpected error: ${err instanceof Error ? err.message : String(err)}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: 'memory-search',
    label: 'Search Memory',
    description: 'Search persistent memory for decisions, bugfixes, patterns, and discoveries.',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
      type: Type.Optional(
        Type.String({
          description: 'Optional type filter',
        }),
      ),
      scope: Type.Optional(Type.String({ description: 'project|personal' })),
      limit: Type.Optional(Type.Number({ description: 'Max results', default: 10 })),
    }),
    renderResult: renderCompactToolResult,
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        let result = deps.state.currentProject
          ? await deps.mem('search', {
              query: params.query,
              ...(params.type ? { type: params.type } : {}),
              ...(params.scope ? { scope: params.scope } : {}),
              ...(params.limit ? { limit: String(params.limit) } : {}),
              project: deps.state.currentProject,
              ...(deps.state.sessionId ? { 'session-id': String(deps.state.sessionId) } : {}),
            })
          : null;

        if (!result || !((result.results as any[]) || []).length) {
          result = await deps.mem('search', {
            query: params.query,
            ...(params.type ? { type: params.type } : {}),
            ...(params.scope ? { scope: params.scope } : {}),
            ...(params.limit ? { limit: String(params.limit) } : {}),
            ...(deps.state.sessionId ? { 'session-id': String(deps.state.sessionId) } : {}),
          });
        }

        if (!result) {
          return { content: [{ type: 'text', text: 'Search failed.' }], details: {}, isError: true };
        }

        const results = (result.results as any[]) || [];
        if (deps.state.pendingRecallFeedback) {
          for (const r of results) {
            deps.state.pendingRecallFeedback.set(r.id, {
              sessionId: deps.state.sessionId || 0,
              query: params.query as string,
            });
          }
        }
        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'No memories found.' }], details: result ?? {} };
        }

        const lines = results.map((r: any) => {
          const score = r._score ? ` (${r._score.toFixed(2)})` : '';
          const trust = r.trust_score != null && r.trust_score < 0.5 ? ' ⚠️' : '';
          const supersedes = (r._relations || []).filter((rel: any) => rel.relation === 'supersedes');
          const relationNote = supersedes.length > 0 ? ` ⚡ superseded by #${supersedes[0].source_id}` : '';
          return `- [#${r.id}] [${r.type}] ${r.title}${score}${trust}${relationNote}${r.snippet ? `\n  ${r.snippet}` : ''}`;
        });

        return normalizeToolResult({
          content: [{ type: 'text', text: `Found ${results.length} memories:\n${lines.join('\n')}` }],
          details: result ?? {},
        });
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Unexpected error: ${err instanceof Error ? err.message : String(err)}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: 'memory-get',
    label: 'Get Memory',
    description: 'Get full memory details by ID.',
    parameters: Type.Object({
      id: Type.Number({ description: 'Memory ID' }),
      allow_cross_project: Type.Optional(
        Type.Boolean({
          description: 'Return full content even when the memory belongs to a different project.',
          default: false,
        }),
      ),
    }),
    renderResult: renderCompactToolResult,
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const result = await deps.mem('get', { id: String(params.id) });
        if (!result || result.error) {
          return { content: [{ type: 'text', text: `Memory #${params.id} not found.` }], details: {}, isError: true };
        }
        const id = parseInt(String(params.id), 10);
        if (deps.state.pendingRecallFeedback?.has(id)) {
          deps.state.pendingRecallFeedback.delete(id);
        }
        if (
          deps.state.currentProject &&
          result.scope === 'project' &&
          result.project &&
          result.project !== deps.state.currentProject &&
          !params.allow_cross_project
        ) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `Memory #${result.id} belongs to project "${result.project}", not current project "${deps.state.currentProject}". ` +
                  'Search current project memory first, or retry with allow_cross_project=true if this cross-project memory is intentional.',
              },
            ],
            details: {
              id: result.id,
              title: result.title,
              type: result.type,
              scope: result.scope,
              project: result.project,
              current_project: deps.state.currentProject,
            },
            isError: true,
          };
        }
        const lines = [
          `## #${result.id} — ${result.title}`,
          `Type: ${result.type} | Scope: ${result.scope} | Project: ${result.project}`,
          '',
          result.content,
        ];
        if (result.expires_at) {
          const expMs = Date.parse(String(result.expires_at).replace(' ', 'T') + 'Z');
          if (Number.isFinite(expMs)) {
            const msLeft = expMs - Date.now();
            if (msLeft <= 0) {
              lines.push('', `⏰ Status: EXPIRED (${result.expires_at})`);
            } else {
              const days = Math.floor(msLeft / 86400000);
              const hours = Math.floor((msLeft % 86400000) / 3600000);
              const countdown =
                days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h` : `${Math.floor(msLeft / 60000)}m`;
              const icon = days < 3 ? '⏰' : '🕒';
              lines.push('', `${icon} Expires: ${result.expires_at} (in ${countdown})`);
            }
          } else {
            lines.push('', `⏰ Expires: ${result.expires_at}`);
          }
        }
        const versions = (result.versions as any[]) || [];
        if (versions.length > 0) {
          lines.push('', '## Edit History');
          for (const v of versions) {
            lines.push(`- **${v.field}** changed (${v.created_at}):`);
            lines.push(`  from: ${String(v.old_value).slice(0, 100)}`);
            lines.push(`  to:   ${String(v.new_value).slice(0, 100)}`);
          }
        }
        const relations = (result.relations as any[]) || [];
        if (relations.length > 0) {
          lines.push('', '## Relations');
          for (const rel of relations) {
            const otherId = rel.source_id === parseInt(String(params.id), 10) ? rel.target_id : rel.source_id;
            const icon = rel.relation === 'supersedes' ? '⚡' : rel.relation === 'duplicate' ? '📋' : '🔗';
            lines.push(`- ${icon} ${rel.relation} → #${otherId} (confidence: ${(rel.confidence * 100).toFixed(0)}%)`);
          }
        }
        return {
          content: [
            {
              type: 'text',
              text: lines.join('\n'),
            },
          ],
          details: result ?? {},
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Unexpected error: ${err instanceof Error ? err.message : String(err)}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: 'memory-update',
    label: 'Update Memory',
    description: 'Update an existing memory in place by ID.',
    parameters: Type.Object({
      id: Type.Number({ description: 'Memory ID' }),
      title: Type.Optional(Type.String({ description: 'New title' })),
      content: Type.Optional(Type.String({ description: 'New content' })),
      type: Type.Optional(
        Type.String({
          description: 'New type',
        }),
      ),
      scope: Type.Optional(Type.String({ description: 'New scope' })),
      topic_key: Type.Optional(Type.String({ description: 'New topic key' })),
      expires_in: Type.Optional(
        Type.String({
          description: 'Set or change TTL duration (e.g., "7d", "2w", "1m", "12h"). Replaces any existing expiry.',
        }),
      ),
      clear_expiry: Type.Optional(
        Type.Boolean({
          description: 'Remove any existing expiry (make memory permanent).',
          default: false,
        }),
      ),
    }),
    renderResult: renderCompactToolResult,
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const args: Record<string, string> = { id: String(params.id) };
        if (params.title) {
          args.title = params.title;
        }
        if (params.content) {
          args.content = params.content;
        }
        if (params.type) {
          args.type = params.type;
        }
        if (params.scope) {
          args.scope = params.scope;
        }
        if (params.topic_key) {
          args['topic-key'] = params.topic_key;
        }
        if (params.expires_in) {
          args['expires-in'] = params.expires_in;
        }
        if (params.clear_expiry) {
          args['clear-expiry'] = 'true';
        }

        const result = await deps.mem('update', args);
        if (!result || result.error) {
          return {
            content: [
              { type: 'text', text: `Failed to update memory #${params.id}: ${result?.error || 'unknown error'}` },
            ],
            details: {},
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: `✅ Memory updated: [#${result.id}] ${result.title}` }],
          details: result ?? {},
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Unexpected error: ${err instanceof Error ? err.message : String(err)}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: 'memory-delete',
    label: 'Delete Memory',
    description: 'Soft-delete a stale, incorrect, or duplicate memory.',
    parameters: Type.Object({
      id: Type.Number({ description: 'Memory ID' }),
    }),
    renderResult: renderCompactToolResult,
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const result = await deps.mem('delete', { id: String(params.id) });
        if (!result || result.error) {
          return {
            content: [
              { type: 'text', text: `Failed to delete memory #${params.id}: ${result?.error || 'unknown error'}` },
            ],
            details: {},
            isError: true,
          };
        }
        return {
          content: [
            { type: 'text', text: `🗑️ Memory #${params.id} deleted${result.hardDeleted ? ' (hard)' : ' (soft)'}` },
          ],
          details: result ?? {},
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Unexpected error: ${err instanceof Error ? err.message : String(err)}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: 'memory-related',
    label: 'Find Related Memories',
    description: 'Find memories linked to the same code symbols.',
    parameters: Type.Object({
      id: Type.Number({ description: 'Memory ID' }),
    }),
    renderResult: renderCompactToolResult,
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const result = await deps.mem('related', { id: String(params.id) });
        if (!result) {
          return { content: [{ type: 'text', text: 'Failed to find related memories.' }], details: {}, isError: true };
        }
        const related = (result.related as any[]) || [];
        if (related.length === 0) {
          return { content: [{ type: 'text', text: 'No related memories found.' }], details: result ?? {} };
        }
        const lines = related.flatMap((r: any) => [
          `### ${r.symbol}`,
          ...(r.memories || []).map((m: any) => `- [#${m.id}] [${m.type}] ${m.title}`),
        ]);
        return {
          content: [{ type: 'text', text: `Related memories for #${params.id}:\n${lines.join('\n')}` }],
          details: result ?? {},
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Unexpected error: ${err instanceof Error ? err.message : String(err)}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: 'memory-load-context',
    label: 'Load Topic Context',
    description: 'Load deeper memory context for a topic.',
    parameters: Type.Object({
      query: Type.String({ description: 'Topic or keyword' }),
      deep: Type.Optional(Type.Boolean({ description: 'More results', default: false })),
      'token-budget': Type.Optional(Type.Number({ description: 'Max tokens to use (default: 2000)', default: 2000 })),
    }),
    renderResult: renderCompactToolResult,
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        if (!deps.state.currentProject) {
          return {
            content: [{ type: 'text', text: "No project detected — can't load context." }],
            details: {},
            isError: true,
          };
        }
        const tokenBudget = params['token-budget'] || 2000;
        const result = await deps.mem('context', {
          project: deps.state.currentProject,
          query: params.query,
          limit: '50',
          'token-budget': String(tokenBudget),
          deep: params.deep ? 'true' : 'false',
          ...(deps.state.sessionId ? { 'session-id': String(deps.state.sessionId) } : {}),
        });

        if (!result) {
          return { content: [{ type: 'text', text: 'Failed to load context.' }], details: {}, isError: true };
        }

        const observations = (result.observations as any[]) || [];
        if (observations.length === 0) {
          return {
            content: [{ type: 'text', text: `No memories found for topic "${params.query}".` }],
            details: result ?? {},
          };
        }

        const lines = observations.map((o: any) => {
          const trust = deps.trustIcon(o.trust_score);
          const trunc = o._truncated ? '…' : '';
          return `- [#${o.id}] [${o.type}] ${o.title}${trust}${trunc}`;
        });

        const totalMemories = result.stats?.total_memories ?? observations.length;
        const budgetStats = result.stats?.budget_tokens
          ? `\n📊 Budget: ${result.stats.budget_used}/${result.stats.budget_tokens} tokens used | ${observations.length} memories${result.stats.truncated_count > 0 ? ` (${result.stats.truncated_count} truncated)` : ''}`
          : '';
        return {
          content: [
            {
              type: 'text',
              text: `## Topic Context: "${params.query}"\n**${totalMemories}** total memories in **${deps.state.currentProject}**, showing ${observations.length} matching "${params.query}":\n\n${lines.join('\n')}${budgetStats}`,
            },
          ],
          details: result ?? {},
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Unexpected error: ${err instanceof Error ? err.message : String(err)}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: 'memory-sync-code-trust',
    label: 'Sync Trust w/ Code Changes',
    description: 'Sync memory trust scores with changed code after pull, checkout, merge, or rebase.',
    parameters: Type.Object({
      repo: Type.String({ description: 'Indexed repo name' }),
    }),
    renderResult: renderCompactToolResult,
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const result = await deps.mem('sync-code-trust', {
          repo: params.repo,
        });

        if (!result) {
          return { content: [{ type: 'text', text: 'Failed to sync trust scores.' }], details: {}, isError: true };
        }

        if (result.message) {
          return {
            content: [{ type: 'text', text: result.message }],
            details: result ?? {},
          };
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

        lines.push(`\n**Total links checked:** ${result.total ?? 0}`);

        return {
          content: [{ type: 'text', text: lines.join('\n') || 'No changes detected.' }],
          details: result ?? {},
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Unexpected error: ${err instanceof Error ? err.message : String(err)}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerCommand('memory-stats', {
    description: 'Show memory layer statistics',
    handler: async (_args, ctx) => {
      const result = await deps.memCmd('stats');
      if (result) {
        ctx.ui.notify(
          `🧠 ${result.total_observations} observations | ${result.total_sessions} sessions | ${result.total_symbol_links} symbol links`,
          'info',
        );
      }
    },
  });

  pi.registerCommand('memory-dream', {
    description: 'Manually trigger the Dream Cycle — clean stale (not just old) memories',
    handler: async (_args, ctx) => {
      try {
        const result = await deps.memCmd('dream');
        if (result) {
          const phases = Object.entries((result as any).phases || {})
            .filter(([k, v]) => k !== 'compact' && (v as any).count > 0)
            .map(([k, v]) => `${k}: ${(v as any).count}`)
            .join(', ');
          ctx.ui.notify(
            `💤 Dream Cycle complete: ${(result as any).totalCleaned} memories cleaned (${phases || 'nothing to clean'})`,
            'info',
          );
        }
      } catch (e) {
        ctx.ui.notify(`Dream Cycle failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
      }
    },
  });

  pi.registerCommand('memory-context', {
    description: 'Reload memory context for current project',
    handler: async (_args, ctx) => {
      if (!deps.state.currentProject) {
        ctx.ui.notify('No project detected', 'error');
        return;
      }
      const result = await deps.mem('context', { project: deps.state.currentProject, limit: '10' });
      if (result) {
        const obs = (result.observations as any[]) || [];
        ctx.ui.notify(`🧠 ${obs.length} observations loaded for ${deps.state.currentProject}`, 'info');
      }
    },
  });
}
