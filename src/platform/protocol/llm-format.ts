function safePop(val: any): string {
  if (typeof val === 'string') {
    return val.split('/').pop() ?? val;
  }
  return String(val ?? '');
}

function formatCodeResult(mode: string, result: any): string {
  switch (mode) {
    case 'search': {
      const results = result.results || [];
      if (!results.length) {
        return `No code results found for ${result.query ?? 'query'}.`;
      }
      return `**Code search:** ${results.length} result${results.length === 1 ? '' : 's'} for ${result.query ?? 'query'}\n${results
        .slice(0, 10)
        .map((r: any, i: number) => {
          const file = r.file ?? r.file_path ?? '?',
            symbol = r.symbol ?? r.symbol_name ?? r.qualified_name ?? r.name ?? '?',
            line = r.line ?? r.start_line ?? '?',
            signature = r.signature ? ` — ${String(r.signature).slice(0, 90)}` : '',
            snippet = r.snippet ? `\n    ${String(r.snippet).replace(/\s+/g, ' ').slice(0, 140)}` : '';
          return `  ${i + 1}. ${symbol} (${file}:${line})${signature}${snippet}`;
        })
        .join('\n')}`;
    }
    case 'callers':
    case 'callees': {
      const items = result.callers || result.callees || [],
        dir = mode === 'callers' ? 'Callers of' : 'Callees from',
        lines = items.map((c: any) => `  [depth ${c.depth ?? '?'}] ${c.name ?? '?'} (${c.file_path ?? '?'})`);
      return `**${dir} ${result.symbol ?? '?'}:**\n${lines.length ? lines.join('\n') : '(none found)'}`;
    }
    case 'blast-radius': {
      const aFiles = result.affected_files || [],
        isNewFormat = result.seed_file !== undefined || (aFiles.length > 0 && aFiles[0].reachability !== undefined);
      if (isNewFormat) {
        const aSyms = result.affected_symbols || [],
          lines: string[] = [
            `**Blast radius of ${result.symbol ?? result.seed_file ?? '?'}** (${result.seed_file ?? '?'})`,
            `Affected files: ${aFiles.length} (by reachability)`,
          ];
        for (const f of aFiles.slice(0, 15)) {
          const score = (f.reachability ?? 0).toFixed(2),
            signals = (f.signals || []).join(', ');
          lines.push(`  [${score}] ${f.path ?? '?'} — via ${signals}`);
        }
        if (aSyms.length > 0) {
          lines.push('');
          lines.push('Affected symbols:');
          for (const s of aSyms.slice(0, 10)) {
            const score = (s.reachability ?? 0).toFixed(2);
            lines.push(`  [${score}] ${s.name ?? '?'} (${s.file ?? '?'})`);
          }
        }
        return lines.join('\n');
      }
      const callers = result.callers || [],
        importers = result.file_importers || [];
      return [
        `**Blast radius of ${result.symbol ?? '?'}** (${result.file ?? '?'})`,
        `Affected files: ${aFiles.length}`,
        callers.length
          ? `\nCallers:\n${callers.map((c: any) => `  [depth ${c.depth ?? '?'}] ${c.name ?? '?'} (${c.file_path ?? '?'})`).join('\n')}`
          : '',
        importers.length
          ? `\nFile importers:\n${importers.map((f: any) => `  [depth ${f.depth ?? '?'}] ${f.path ?? '?'}`).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    }
    case 'dead-code': {
      const deadFiles = result.dead_files || [],
        deadSyms = result.dead_symbols || [];
      return [
        `**Dead code analysis** — ${deadFiles.length} dead files, ${deadSyms.length} dead symbols`,
        deadFiles.length ? `Dead files:\n${deadFiles.map((f: any) => `  ${f.path ?? '?'}`).join('\n')}` : '',
        deadSyms
          .slice(0, 20)
          .map(
            (s: any) =>
              `  [${s.confidence ?? '?'}] ${s.name ?? '?'} (${s.file ?? '?'}) — ${(s.signals || []).join(', ')}`,
          )
          .join('\n'),
      ]
        .filter(Boolean)
        .join('\n');
    }
    case 'complexity': {
      if (Array.isArray(result)) {
        const high = result.filter((r: any) => r.assessment === 'high'),
          med = result.filter((r: any) => r.assessment === 'medium');
        return [
          `**Complexity:** ${result.length} functions — ${high.length} high, ${med.length} medium, ${result.length - high.length - med.length} low`,
          ...high
            .slice(0, 10)
            .map(
              (r: any) =>
                `  🔴 ${r.name ?? '?'} (${safePop(r.file_path)}): cyclomatic=${r.cyclomatic ?? '?'} nesting=${r.nesting_depth ?? '?'}`,
            ),
          ...med.slice(0, 5).map((r: any) => `  🟡 ${r.name ?? '?'}: cyclomatic=${r.cyclomatic ?? '?'}`),
        ].join('\n');
      }
      return `**${result.name ?? '?'}** (${safePop(result.file_path)}): cyclomatic=${result.cyclomatic ?? '?'} nesting=${result.nesting_depth ?? '?'} params=${result.param_count ?? '?'} lines=${result.lines_of_code ?? '?'} — ${result.assessment ?? '?'}`;
    }
    case 'deps': {
      const edges = result.edges || [],
        down = result.downstream || [],
        up = result.upstream || [];
      if (down.length || up.length) {
        return [
          down.length
            ? `**Downstream:**\n${down.map((d: any) => `  [${d.depth ?? '?'}] ${d.path ?? '?'}`).join('\n')}`
            : '',
          up.length ? `**Upstream:**\n${up.map((u: any) => `  [${u.depth ?? '?'}] ${u.path ?? '?'}`).join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      }
      return `**Import graph:** ${edges.length} edges\n${edges
        .slice(0, 20)
        .map((e: any) => `  ${e.source ?? '?'} → ${e.target ?? '?'} (${e.type ?? '?'})`)
        .join('\n')}`;
    }
    case 'outline': {
      const outline = result;
      if (outline.not_found) {
        const suggestions = (outline.suggestions || []).slice(0, 10).map((file: string) => `  ${file}`);
        return [
          `File not found: ${outline.file ?? '?'}`,
          outline.message || '',
          suggestions.length ? `Suggestions:\n${suggestions.join('\n')}` : '',
          outline.hint || '',
        ]
          .filter(Boolean)
          .join('\n');
      }
      if (outline.directory) {
        const files = (outline.files || []).slice(0, 25).map((file: string) => `  ${file}`),
          suffix = outline.truncated
            ? `\n  ... ${Math.max(0, (outline.total_files || 0) - files.length)} more files`
            : '';
        return `**Directory outline** ${outline.file ?? ''}: ${outline.total_files ?? files.length} files\n${files.join('\n')}${suffix}\nRefine --file to a specific file for symbols.`;
      }
      if (outline.classes) {
        const lines = outline.classes.map((c: any) => {
            const methods = (c.methods || [])
              .map(
                (m: any) =>
                  `    ${m.assessment ? `[${m.assessment}] ` : ''}${m.kind ?? '?'} ${m.name ?? '?'}${m.signature ? `: ${m.signature.slice(0, 60)}` : ''}`,
              )
              .join('\n');
            return `  📦 ${c.name ?? '?'}\n${methods}`;
          }),
          standalone = (outline.standalone || []).map(
            (s: any) =>
              `  ${s.assessment ? `[${s.assessment}] ` : ''}${s.kind ?? '?'} ${s.name ?? '?'}${s.signature ? `: ${s.signature.slice(0, 60)}` : ''}`,
          ),
          body = [...lines, ...standalone].join('\n');
        return body ? `**File outline**\n${body}` : `No symbols found in ${outline.file ?? 'file'}.`;
      }
      return JSON.stringify(outline, null, 2);
    }
    case 'churn': {
      if (result.error) {
        return `Error: ${result.error}`;
      }
      if (result.repo) {
        return `**${result.repo}** churn (${result.window_days ?? '?'}d): ${result.total_files_changed ?? 0} files changed\n${(
          result.top_files || []
        )
          .slice(0, 10)
          .map((f: any) => `  ${f.file ?? '?'}: ${f.commits ?? 0} commits (${f.churn_per_week ?? '?'}/wk)`)
          .join('\n')}`;
      }
      return `**Churn:** ${result.commits ?? 0} commits, ${result.unique_authors ?? 0} authors (${result.churn_per_week ?? '?'}/wk)\n  First: ${result.first_seen ?? '?'} | Last: ${result.last_modified ?? '?'}`;
    }
    case 'hotspots': {
      if (!result.hotspots?.length) {
        return `No hotspots found${result.note ? ` (${result.note})` : '.'}`;
      }
      return result.hotspots
        .map(
          (h: any, i: number) =>
            `${i + 1}. **${h.name ?? '?'}** (${h.kind ?? '?'}) — ${safePop(h.file_path)}\n   Risk: ${h.risk ?? '?'} | Score: ${h.hotspot_score ?? '?'} | Complexity: ${h.cyclomatic ?? '?'} | Commits: ${h.commits ?? 0} | Churn: ${h.churn_per_week ?? '?'}/wk`,
        )
        .join('\n\n');
    }
    case 'cycles': {
      if (!result.cycles?.length) {
        return 'No dependency cycles found — import graph is acyclic.';
      }
      return result.cycles
        .map(
          (c: any, i: number) =>
            `${i + 1}. **Cycle ${i + 1}** (${c.size ?? '?'} files)\n   Files: ${(c.files || []).map((f: string) => safePop(f)).join(' → ')}\n   Edges: ${(c.edges || []).map((e: any) => `${safePop(e.from)} → ${safePop(e.to)}`).join(', ')}`,
        )
        .join('\n\n');
    }
    case 'importance': {
      if (!result.importance?.length) {
        return 'No symbols found.';
      }
      return `Top ${result.importance.length} of ${result.total_symbols ?? result.importance.length} symbols by PageRank:\n\n${result.importance
        .map(
          (s: any, i: number) =>
            `${i + 1}. **${s.name ?? '?'}** (${s.kind ?? '?'}) — ${safePop(s.file_path)} — PageRank: ${s.pagerank ?? '?'}`,
        )
        .join('\n')}`;
    }
    case 'coupling': {
      if (!result.metrics?.length) {
        return 'No coupling data found.';
      }
      return result.metrics
        .map((m: any) => {
          const short = safePop(m.file_path);
          return `**${short}** (${m.category ?? '?'})\n   Ca=${m.afferent ?? 0} Ce=${m.efferent ?? 0} I=${m.instability ?? '?'}`;
        })
        .join('\n\n');
    }
    case 'extractable': {
      if (!result.candidates?.length) {
        return 'No extraction candidates found. Try lowering --min-complexity or --min-callers.';
      }
      return result.candidates
        .map(
          (c: any, i: number) =>
            `${i + 1}. **${c.name ?? '?'}** (${c.kind ?? '?'}) — ${safePop(c.file_path)}\n   Score: ${c.extraction_score ?? '?'} | Complexity: ${c.cyclomatic ?? '?'} | Callers: ${c.caller_file_count ?? 0} files\n   Called from: ${(c.caller_files || []).map((f: string) => safePop(f)).join(', ')}`,
        )
        .join('\n\n');
    }
    case 'hierarchy': {
      if (result.error) {
        return `Error: ${result.error}`;
      }
      let out = `**${result.name ?? '?'}** (${result.kind ?? '?'}) — ${safePop(result.file_path)}`;
      if (result.ancestors?.length) {
        out += `\n\nAncestors: ${result.ancestors.map((a: any) => `${a.name ?? '?'} (${a.kind ?? '?'})`).join(' → ')}`;
      }
      if (result.descendants?.length) {
        out += `\n\nMembers: ${result.descendants.map((d: any) => `${d.name ?? '?'} (${d.kind ?? '?'})`).join(', ')}`;
      }
      if (!result.ancestors?.length && !result.descendants?.length) {
        out += `\n\n(No parent classes or child members found)`;
      }
      return out;
    }
    case 'signal-chains': {
      if (!result.chains?.length) {
        return result.note || 'No signal chains found.';
      }
      return result.chains
        .map((c: any) => {
          const gw = c.gateway || c,
            label = gw.method ? `${gw.method} ${gw.path ?? ''}` : (gw.name ?? '?');
          return `▶ **${label}** (${gw.kind ?? '?'})\n${(c.chain || [])
            .map((s: any, i: number) => `${'  '.repeat(i + 1)}→ ${s.name ?? '?'} (${s.kind || 'fn'})`)
            .join('\n')}`;
        })
        .join('\n\n');
    }
    case 'layer-violations': {
      if (result.error) {
        return `Error: ${result.error}`;
      }
      if (result.note) {
        return result.note;
      }
      if (!result.violations?.length) {
        return 'No layer violations found.';
      }
      return result.violations
        .map(
          (v: any) =>
            `❌ **${v.source_layer ?? '?'}** → **${v.target_layer ?? '?'}**: ${safePop(v.source)} imports ${safePop(v.target)}\n   Rule: ${v.rule ?? '?'}`,
        )
        .join('\n\n');
    }
    case 'coding-context': {
      if (result.error) {
        return `Error: ${result.error}`;
      }
      const target = result.target || {},
        summary = result.summary || {};
      let targetLabel = 'target';
      if (target.symbol) {
        targetLabel = `${target.symbol} (${target.file ?? '?'})`;
      } else if (target.file) {
        targetLabel = target.file;
      }
      const lines = [
        `**Coding context:** ${targetLabel}`,
        `Risk: ${summary.risk ?? 'unknown'} | review: ${summary.review_bar ?? 'unknown'} | affected files: ${summary.affected_files ?? 0}`,
      ];
      if ((summary.reasons || []).length) {
        lines.push(`Reasons: ${(summary.reasons || []).slice(0, 5).join(', ')}`);
      }
      if ((result.related_files || []).length) {
        lines.push(
          '',
          'Related files:',
          ...(result.related_files || []).slice(0, 10).map((file: string) => `  ${file}`),
        );
      }
      if ((result.likely_tests || []).length) {
        lines.push(
          '',
          'Likely tests:',
          ...(result.likely_tests || [])
            .slice(0, 8)
            .map((test: any) => `  ${test.file ?? '?'}${test.reasons?.length ? ` - ${test.reasons.join(', ')}` : ''}`),
        );
      }
      if ((result.recommended_next || []).length) {
        lines.push('', 'Next:', ...(result.recommended_next || []).slice(0, 5).map((step: string) => `  - ${step}`));
      }
      if ((result.partial_errors || []).length) {
        lines.push(
          '',
          'Partial errors:',
          ...(result.partial_errors || [])
            .slice(0, 5)
            .map((err: any) => `  ${err.analyzer ?? '?'}: ${err.error ?? 'failed'}`),
        );
      }
      return lines.join('\n');
    }
    case 'preflight': {
      const code = result.likely_existing_code || [],
        memories = result.similar_past_tasks || [],
        warnings = result.duplicate_warnings || [],
        files = result.related_files || [],
        lines = [
          `**Preflight:** ${result.task_summary ?? 'task'} — risk: ${result.risk ?? 'unknown'} | duplicate risk: ${result.duplicate_risk ?? 'unknown'}`,
          `Recommended: ${result.recommended_action ?? 'Review relevant context before editing.'}`,
        ];
      if (warnings.length) {
        lines.push('', 'Duplicate warnings:');
        for (const w of warnings.slice(0, 5)) {
          lines.push(`  ⚠️ ${w.symbol ?? '?'} (${w.file ?? '?'}) — ${w.reason ?? 'similar intent'}`);
        }
      }
      if (code.length) {
        lines.push('', 'Likely existing code:');
        for (const c of code.slice(0, 8)) {
          lines.push(`  ${c.symbol ?? '?'} (${c.file ?? '?'}:${c.line ?? '?'})`);
        }
      }
      if (memories.length) {
        lines.push('', 'Similar past tasks:');
        for (const m of memories.slice(0, 5)) {
          lines.push(`  [${m.type ?? '?'}] ${m.title ?? '?'}`);
        }
      }
      if (files.length) {
        lines.push('', `Related files: ${files.slice(0, 8).join(', ')}`);
      }
      return lines.join('\n');
    }
    case 'agent-pack': {
      const lines = [
        `**Agent pack:** ${result.task_summary ?? 'task'} — risk: ${result.risk ?? 'unknown'}`,
        `Recommended: ${result.recommended_action ?? 'Review relevant context before editing.'}`,
      ];
      if (result.must_read?.length) {
        lines.push('', 'Must read:', ...result.must_read.slice(0, 10).map((f: string) => `  - ${f}`));
      }
      if (result.duplicate_warnings?.length) {
        lines.push('', 'Duplicate warnings:');
        for (const w of result.duplicate_warnings.slice(0, 5)) {
          lines.push(`  ⚠️ ${w.symbol ?? '?'} (${w.file ?? '?'})`);
        }
      }
      if (result.past_decisions?.length) {
        lines.push('', 'Past decisions:');
        for (const d of result.past_decisions.slice(0, 5)) {
          lines.push(`  - [${d.type ?? '?'}] ${d.title ?? '?'}`);
        }
      }
      if (result.suggested_plan?.length) {
        lines.push(
          '',
          'Suggested plan:',
          ...result.suggested_plan.map((step: string, i: number) => `  ${i + 1}. ${step}`),
        );
      }
      return lines.join('\n');
    }
    case 'index-repo': {
      if (result.error) {
        return `Error: ${result.error}`;
      }
      return `✅ Repo "${result.name || result.repo}" indexed: ${result.file_count || 0} files, ${result.symbol_count || 0} symbols`;
    }
    case 'reindex-repo': {
      if (result.error) {
        return `Error: ${result.error}`;
      }
      const reindexSymbols = result.symbol_count || 0,
        reindexExtracted = result.symbols_extracted ?? null,
        reindexUnchanged = result.files_unchanged === result.file_count;
      if (reindexUnchanged) {
        return `✅ Repo "${result.name || result.repo}" already up-to-date: ${result.file_count || 0} files, ${reindexSymbols} symbols (no changes since last index)`;
      }
      const extractedNote = reindexExtracted !== null ? ` (${reindexExtracted} new)` : '';
      return `✅ Repo "${result.name || result.repo}" reindexed: ${result.file_count || 0} files, ${reindexSymbols} symbols${extractedNote} (${result.mode || 'incremental'})`;
    }
    case 'index-docs': {
      if (result.error) {
        return `Error: ${result.error}`;
      }
      return `✅ Doc repo "${result.name || result.repo}" indexed: ${result.section_count || 0} sections in ${result.file_count || 0} files`;
    }
    case 'reindex-docs': {
      if (result.error) {
        return `Error: ${result.error}`;
      }
      return `✅ Doc repo "${result.name || result.repo}" reindexed: ${result.section_count || 0} sections (${result.mode || 'full'})`;
    }
    case 'health': {
      const diagnostics = result.diagnostics || {},
        lines = [
          `# Index Health: ${result.repo}`,
          '',
          `Score: ${result.health_score}`,
          `Indexed: ${result.indexed_files} files, ${result.indexed_symbols} symbols`,
          `Fresh: ${result.stale ? 'no' : 'yes'}`,
        ];
      if (result.scan) {
        const delta = result.scan.indexed_file_delta;
        lines.push(
          `Discovered: ${result.scan.parseable_files_found} parseable files (${delta >= 0 ? '+' : ''}${delta} vs indexed)`,
        );
      }
      lines.push(
        `Diagnostics: ok=${diagnostics.ok || 0}, zero_symbols=${diagnostics.zero_symbols || 0}, error=${diagnostics.error || 0}`,
      );
      if ((result.recommendations || []).length) {
        lines.push('', 'Recommendations:', ...(result.recommendations || []).map((r: string) => `- ${r}`));
      }
      return lines.join('\n');
    }
    case 'dupes': {
      const groups = result.duplicate_groups || [];
      if (!groups.length) {
        return 'No duplicate code groups found.';
      }
      return `Found ${result.groups_found ?? groups.length} duplicate groups (${result.total_symbols_scanned ?? '?'} symbols scanned, ${result.scan_duration_ms ?? '?'}ms):\n\n${groups
        .slice(0, 10)
        .map((g: any) => {
          const instances = (g.instances || [])
            .map((i: any) => `  - ${i.symbol_name} in ${safePop(i.file_path)}:${i.line_start ?? '?'}`)
            .join('\n');
          return `**${g.intent || 'Group'}** (${g.risk || '?'}, ${g.detection_type || '?'})\n${instances}`;
        })
        .join('\n\n')}`;
    }
    case 'audit-diff': {
      const violations = result.violations || [],
        lines = [
          `**Audit diff** — risk: ${result.risk || '?'} (score ${result.risk_score ?? '?'}), files checked: ${result.files_checked ?? 0}`,
        ];
      if (!violations.length) {
        lines.push('', 'No violations found.');
        return lines.join('\n');
      }
      lines.push('', `Violations (${violations.length}):`);
      for (const v of violations.slice(0, 20)) {
        lines.push(`  [${v.severity || '?'}] ${v.type || '?'}: ${v.message || ''}`);
      }
      return lines.join('\n');
    }
    case 'enrich-symbols': {
      const total = result.total_symbols ?? 0,
        enriched = result.enriched_count ?? 0,
        skipped = result.skipped_count ?? 0;
      if (result.error) {
        return `Error: ${result.error}`;
      }
      return `Enriched ${enriched} / ${total} symbols (${skipped} skipped).`;
    }
    default:
      return JSON.stringify(result, null, 2).slice(0, 2000);
  }
}

function formatDocResult(mode: string, result: any): string {
  switch (mode) {
    case 'search': {
      const items = result.results || [];
      return `**Doc search:** ${items.length} results\n${items
        .slice(0, 15)
        .map((r: any) => `  [${r.role ?? '?'}] (L${r.level ?? '?'}) ${r.title ?? '?'} — ${r.file_path ?? '?'}`)
        .join('\n')}`;
    }
    case 'outline': {
      if (Array.isArray(result)) {
        const walk = (nodes: any[], indent: number) =>
          nodes
            .map(
              (n: any) =>
                `${'  '.repeat(indent)}${'#'.repeat(Math.min(n.level || 1, 6))} ${n.title} [${n.role}]\n${n.children?.length ? walk(n.children, indent + 1) : ''}`,
            )
            .join('');
        return walk(result, 0);
      }
      const files = result.files || [];
      return `**Docs:** ${files.length} files\n${files.map((f: any) => `  ${f.path} (${f.section_count} sections)`).join('\n')}`;
    }
    case 'backlinks': {
      const bl = result.backlinks || [];
      return `**Backlinks:** ${bl.length}\n${bl.map((b: any) => `  ← ${b.source_file ?? '?'}#${b.source_title ?? '?'} ("${b.link_text ?? ''}")`).join('\n')}`;
    }
    case 'broken-links': {
      const bad = result.broken_links || [];
      return `**Broken links:** ${bad.length}\n${bad
        .slice(0, 20)
        .map((l: any) => `  ${l.source_file ?? '?'}: "${l.link_text ?? ''}" → ${l.target_path ?? '?'}`)
        .join('\n')}`;
    }
    case 'glossary': {
      if (result.error) {
        return result.error;
      }
      if (Array.isArray(result)) {
        return `**Glossary:** ${result.length} terms\n${result
          .slice(0, 20)
          .map((t: any) => `  **${t.term ?? '?'}** — ${(t.definition ?? '').slice(0, 80)}`)
          .join('\n')}`;
      }
      return `**${result.term ?? '?'}** — ${result.definition ?? ''}`;
    }
    case 'tutorial-path': {
      const chain = result.chain || [];
      return `**Tutorial path:**\n${chain.map((c: any, i: number) => `  ${i + 1}. ${c.title ?? '?'} (section #${c.section_id ?? '?'})`).join('\n')}`;
    }
    case 'code-examples': {
      const examples = result.results || [];
      return `**Code examples:** ${examples.length}\n${examples.map((e: any) => `  ${e.section_title ?? '?'} (${e.file_path ?? '?'}) [${e.lang ?? '?'}]:\n${(e.content ?? '').slice(0, 150)}...`).join('\n\n')}`;
    }
    case 'orphans': {
      if (!result.orphans?.length) {
        return 'No orphan sections found — all sections have inbound links.';
      }
      return `Found ${result.total ?? result.orphans.length} orphan sections:\n\n${result.orphans
        .map(
          (s: any) => `- **${s.title ?? '?'}** (L${s.level ?? '?'}) — ${safePop(s.file_path)} [${s.role || 'other'}]`,
        )
        .join('\n')}`;
    }
    case 'coverage': {
      return (
        `Doc coverage: ${result.coverage_pct ?? '?'}% (${result.documented ?? 0}/${result.total_symbols ?? 0} symbols documented)\n\n` +
        `**Documented** (showing up to 20):\n${(result.documented_list || [])
          .map((s: any) => `  ✅ ${s.name ?? '?'} (${s.kind ?? '?'}) — ${safePop(s.file_path)}`)
          .join('\n')}\n\n**Undocumented** (showing up to 20):\n${(result.undocumented_list || [])
          .map((s: any) => `  ❌ ${s.name ?? '?'} (${s.kind ?? '?'}) — ${safePop(s.file_path)}`)
          .join('\n')}`
      );
    }
    case 'stale-pages': {
      if (!result.stale?.length && !result.missing?.length) {
        return 'No stale or missing pages found. Docs are up to date.';
      }
      let out = '';
      if (result.stale?.length) {
        out += `**Stale pages** (${result.stale.length} modified since index):\n${result.stale
          .map(
            (s: any) =>
              `  📝 ${s.path ?? '?'} (indexed: ${s.indexed_mtime ? new Date(s.indexed_mtime).toISOString().slice(0, 19) : '?'}, current: ${s.current_mtime ? new Date(s.current_mtime).toISOString().slice(0, 19) : '?'})`,
          )
          .join('\n')}`;
      }
      if (result.missing?.length) {
        if (out) {
          out += '\n';
        }
        out += `**Missing pages** (${result.missing.length} deleted since index):\n${result.missing
          .map((s: any) => `  🗑️ ${s.path ?? '?'}`)
          .join('\n')}`;
      }
      return out || 'No stale or missing pages found.';
    }
    case 'duplicates': {
      if (!result.duplicates?.length) {
        return 'No duplicate sections found.';
      }
      return `Found ${result.total_duplicate_groups ?? result.duplicates.length} duplicate groups:\n\n${result.duplicates
        .map(
          (d: any) =>
            `**Hash ${(d.content_hash ?? '').slice(0, 8)}...** (${d.count ?? '?'} copies)\n${(d.sections || []).map((s: any) => `  - "${s.title ?? '?'}" in ${safePop(s.file_path)}`).join('\n')}`,
        )
        .join('\n\n')}`;
    }
    default:
      return JSON.stringify(result, null, 2).slice(0, 2000);
  }
}

export { formatCodeResult, formatDocResult };
