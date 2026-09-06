function createAurexRepository(deps) {
  const { sqlJson, sqlRun } = deps,
    repository = {
      // --- Missions ---
      createMission({ id, description, status, configJson }) {
        sqlRun('INSERT INTO missions (id, description, status, config_json) VALUES (?, ?, ?, ?)', [
          id,
          description,
          status || 'planning',
          typeof configJson === 'string' ? configJson : JSON.stringify(configJson || {}),
        ]);
        return sqlJson('SELECT * FROM missions WHERE id = ?', [id]);
      },
      getMission(id) {
        return sqlJson('SELECT * FROM missions WHERE id = ?', [id]);
      },
      updateMissionStatus(id, status) {
        sqlRun('UPDATE missions SET status = ? WHERE id = ?', [status, id]);
        // Re-select so handlers can 404 on a missing id instead of
        // reporting blind success (#288).
        return sqlJson('SELECT * FROM missions WHERE id = ?', [id]);
      },

      // --- Milestones ---
      createMilestone({ id, missionId, title, description, orderIndex, status }) {
        sqlRun(
          'INSERT INTO milestones (id, mission_id, title, description, order_index, status) VALUES (?, ?, ?, ?, ?, ?)',
          [id, missionId, title, description || '', orderIndex || 0, status || 'planned'],
        );
        return sqlJson('SELECT * FROM milestones WHERE id = ?', [id]);
      },
      getMilestone(id) {
        return sqlJson('SELECT * FROM milestones WHERE id = ?', [id]);
      },
      updateMilestoneStatus(id, status) {
        sqlRun('UPDATE milestones SET status = ? WHERE id = ?', [status, id]);
        return sqlJson('SELECT * FROM milestones WHERE id = ?', [id]);
      },
      listMilestonesForMission(missionId) {
        return sqlJson('SELECT * FROM milestones WHERE mission_id = ? ORDER BY order_index ASC', [missionId]);
      },

      // --- Working Units ---
      createWorkingUnit({
        id,
        milestoneId,
        description,
        declaredPaths,
        declaredModules,
        status,
        taskBranch,
        worktreePath,
        sessionId,
      }) {
        sqlRun(
          'INSERT INTO working_units (id, milestone_id, description, declared_paths, declared_modules, status, task_branch, worktree_path, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            id,
            milestoneId,
            description || '',
            JSON.stringify(declaredPaths || []),
            JSON.stringify(declaredModules || []),
            status || 'spawned',
            taskBranch || '',
            worktreePath || '',
            sessionId || null,
          ],
        );
        return sqlJson('SELECT * FROM working_units WHERE id = ?', [id]);
      },
      getWorkingUnit(id) {
        return sqlJson('SELECT * FROM working_units WHERE id = ?', [id]);
      },
      getWorkingUnitsForMilestone(milestoneId) {
        return sqlJson('SELECT * FROM working_units WHERE milestone_id = ?', [milestoneId]);
      },
      updateWorkingUnitStatus(id, status) {
        sqlRun('UPDATE working_units SET status = ? WHERE id = ?', [status, id]);
        return sqlJson('SELECT * FROM working_units WHERE id = ?', [id]);
      },

      // --- Worker Handoffs ---
      createHandoff({
        id,
        unitId,
        missionId,
        milestoneId,
        featureName,
        description,
        implemented,
        remaining,
        rationale,
        assumptions,
        unresolvedUncertainties,
        errorsEncountered,
        commandsRun,
        gitCommitHash,
      }) {
        sqlRun(
          `INSERT INTO handoffs (
          id, unit_id, mission_id, milestone_id,
          feature_name, description, implemented, remaining, rationale,
          assumptions, unresolved_uncertainties, errors_encountered,
          commands_run, git_commit_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            unitId,
            missionId || '',
            milestoneId || '',
            featureName || '',
            description || '',
            implemented || '',
            remaining || '',
            rationale || '',
            assumptions || '',
            unresolvedUncertainties || '',
            errorsEncountered || '',
            JSON.stringify(commandsRun || []),
            gitCommitHash || '',
          ],
        );
        return sqlJson('SELECT * FROM handoffs WHERE id = ?', [id]);
      },
      getHandoffsForMilestone(milestoneId) {
        return sqlJson('SELECT * FROM handoffs WHERE milestone_id = ?', [milestoneId]);
      },
      getHandoffsForMission(missionId) {
        return sqlJson('SELECT * FROM handoffs WHERE mission_id = ?', [missionId]);
      },
      getHandoffForUnit(unitId) {
        return sqlJson('SELECT * FROM handoffs WHERE unit_id = ?', [unitId]);
      },

      // --- Validation Contracts ---
      createContract({ id, milestoneId, version, content, supersedes }) {
        sqlRun(
          'INSERT INTO validation_contracts (id, milestone_id, version, content, supersedes) VALUES (?, ?, ?, ?, ?)',
          [
            id,
            milestoneId,
            version || 1,
            typeof content === 'string' ? content : JSON.stringify(content || {}),
            supersedes || null,
          ],
        );
        return sqlJson('SELECT * FROM validation_contracts WHERE id = ?', [id]);
      },
      supersedeContract({ oldId, newId, milestoneId, newContract, rescopeEvent }) {
        const existing = sqlJson('SELECT version, milestone_id FROM validation_contracts WHERE id = ?', [oldId]),
          version = (existing.length > 0 ? existing[0].version : 0) + 1,
          mid = milestoneId || (existing.length > 0 ? existing[0].milestone_id : null);
        sqlRun(
          'INSERT INTO validation_contracts (id, milestone_id, version, content, supersedes) VALUES (?, ?, ?, ?, ?)',
          [
            newId,
            mid,
            version,
            typeof newContract === 'string' ? newContract : JSON.stringify(newContract || {}),
            oldId,
          ],
        );
        sqlRun('UPDATE validation_contracts SET superseded_by = ? WHERE id = ?', [newId, oldId]);
        if (rescopeEvent) {
          sqlRun(
            'INSERT INTO rescope_events (id, milestone_id, contract_id, reason, previous_scope, new_scope) VALUES (?, ?, ?, ?, ?, ?)',
            [
              rescopeEvent.id || `re-${Date.now()}`,
              mid,
              oldId,
              rescopeEvent.reason || '',
              rescopeEvent.previousScope || '',
              rescopeEvent.newScope || '',
            ],
          );
        }
        return sqlJson('SELECT * FROM validation_contracts WHERE id = ?', [newId]);
      },
      getContractHistory(milestoneId) {
        return sqlJson('SELECT * FROM validation_contracts WHERE milestone_id = ? ORDER BY version', [milestoneId]);
      },

      // --- Validation Verdicts ---
      createVerdict({ id, milestoneId, contractId, validatorType, sessionId, verdict, findings, failedUnitIds }) {
        sqlRun(
          'INSERT INTO validation_verdicts (id, milestone_id, contract_id, validator_type, session_id, verdict, findings, failed_unit_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            id,
            milestoneId,
            contractId,
            validatorType,
            sessionId,
            verdict,
            findings || '',
            JSON.stringify(failedUnitIds || []),
          ],
        );
        return sqlJson('SELECT * FROM validation_verdicts WHERE id = ?', [id]);
      },
      classifyVerdict(id, classification) {
        sqlRun('UPDATE validation_verdicts SET classification = ? WHERE id = ?', [classification, id]);
        return sqlJson('SELECT * FROM validation_verdicts WHERE id = ?', [id]);
      },
      getVerdicts(milestoneId) {
        return sqlJson('SELECT * FROM validation_verdicts WHERE milestone_id = ?', [milestoneId]);
      },

      // --- Broadcasts ---
      createBroadcast({ id, missionId, authorId, authorType, category, title, content, status, ttl, expiresAt }) {
        sqlRun(
          'INSERT INTO broadcasts (id, mission_id, author_id, author_type, category, title, content, status, ttl, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            id,
            missionId,
            authorId,
            authorType,
            category || 'info',
            title || '',
            content || '',
            status || 'active',
            ttl ?? null,
            expiresAt || null,
          ],
        );
        return sqlJson('SELECT * FROM broadcasts WHERE id = ?', [id]);
      },
      transitionBroadcast(id, newStatus) {
        sqlRun('UPDATE broadcasts SET status = ? WHERE id = ?', [newStatus, id]);
        return sqlJson('SELECT * FROM broadcasts WHERE id = ?', [id]);
      },
      getBroadcasts(missionId, statusFilter) {
        if (statusFilter && statusFilter.length > 0) {
          const placeholders = statusFilter.map(() => '?').join(',');
          return sqlJson(`SELECT * FROM broadcasts WHERE mission_id = ? AND status IN (${placeholders})`, [
            missionId,
            ...statusFilter,
          ]);
        }
        return sqlJson('SELECT * FROM broadcasts WHERE mission_id = ?', [missionId]);
      },

      // --- Research Findings ---
      createFinding({ id, missionId, authorId, domain, title, content, relevance, status, ttl, expiresAt }) {
        sqlRun(
          'INSERT INTO research_findings (id, mission_id, author_id, domain, title, content, relevance, status, ttl, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            id,
            missionId,
            authorId,
            JSON.stringify(domain || []),
            title || '',
            content || '',
            relevance || 'medium',
            status || 'unverified',
            ttl ?? null,
            expiresAt || null,
          ],
        );
        return sqlJson('SELECT * FROM research_findings WHERE id = ?', [id]);
      },
      transitionFinding(id, newStatus) {
        sqlRun('UPDATE research_findings SET status = ? WHERE id = ?', [newStatus, id]);
        return sqlJson('SELECT * FROM research_findings WHERE id = ?', [id]);
      },
      getFindings(missionId, status) {
        if (status) {
          return sqlJson('SELECT * FROM research_findings WHERE mission_id = ? AND status = ?', [missionId, status]);
        }
        return sqlJson('SELECT * FROM research_findings WHERE mission_id = ?', [missionId]);
      },

      // --- Agent Sessions ---
      registerSession({ sessionId, agentType, missionId, milestoneId, unitId }) {
        sqlRun(
          'INSERT INTO agent_sessions (session_id, agent_type, mission_id, milestone_id, unit_id) VALUES (?, ?, ?, ?, ?)',
          [sessionId, agentType, missionId, milestoneId || null, unitId || null],
        );
      },
      getSessionsForMilestone(milestoneId) {
        return sqlJson('SELECT * FROM agent_sessions WHERE milestone_id = ?', [milestoneId]);
      },

      // --- Cost Tracking ---
      logCost({ id, missionId, agentSessionId, model, promptTokens, completionTokens, cost, timestamp }) {
        sqlRun(
          'INSERT INTO cost_entries (id, mission_id, agent_session_id, model, prompt_tokens, completion_tokens, cost, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            id,
            missionId,
            agentSessionId,
            model,
            promptTokens || 0,
            completionTokens || 0,
            cost || 0,
            timestamp || new Date().toISOString(),
          ],
        );
      },
      getMissionCost(missionId) {
        const rows = sqlJson(
          'SELECT SUM(cost) as totalCost, SUM(prompt_tokens + completion_tokens) as totalTokens, COUNT(*) as entries FROM cost_entries WHERE mission_id = ?',
          [missionId],
        );
        if (rows.length === 0) {
          return { totalCost: 0, totalTokens: 0, entries: 0 };
        }
        return {
          totalCost: rows[0].totalCost || 0,
          totalTokens: rows[0].totalTokens || 0,
          entries: rows[0].entries || 0,
        };
      },

      // --- Retry / Rescope ---
      incrementRetry(milestoneId) {
        sqlRun('UPDATE milestones SET retries = retries + 1 WHERE id = ?', [milestoneId]);
        const rows = sqlJson('SELECT retries, rescopes FROM milestones WHERE id = ?', [milestoneId]);
        // null (not a fabricated counter object) when the milestone does
        // not exist, so the handler can 404 (#288).
        return rows.length > 0 ? rows[0] : null;
      },
      logRescope(milestoneId, event) {
        const exists = sqlJson('SELECT id FROM milestones WHERE id = ?', [milestoneId]);
        if (exists.length === 0) {
          return false;
        }
        sqlRun('UPDATE milestones SET rescopes = rescopes + 1 WHERE id = ?', [milestoneId]);
        sqlRun(
          'INSERT INTO rescope_events (id, milestone_id, contract_id, reason, previous_scope, new_scope) VALUES (?, ?, ?, ?, ?, ?)',
          [
            `re-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            milestoneId,
            event.contractId || '',
            event.reason || '',
            event.previousScope || '',
            event.newScope || '',
          ],
        );
        return true;
      },

      // --- Todo Ledgers ---
      createMissionLedger({
        missionId,
        missionTitle,
        status,
        sourceMission,
        plannerSummary,
        acceptanceCriteria,
        constraints,
        assumptions,
        humanQuestions,
      }) {
        assertInSet(status || 'planning', MISSION_LEDGER_STATUSES, 'status');
        sqlRun(
          `INSERT INTO todo_ledgers (
          mission_id, mission_title, status, source_mission, planner_summary,
          acceptance_criteria, constraints_json, assumptions, human_questions
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            missionId,
            missionTitle || '',
            status || 'planning',
            sourceMission || '',
            plannerSummary || '',
            toJson(acceptanceCriteria || []),
            toJson(constraints || []),
            toJson(assumptions || []),
            toJson(humanQuestions || []),
          ],
        );
        this.recordMissionEvent(missionId, {
          eventType: 'ledger_created',
          payload: { status: status || 'planning', missionTitle: missionTitle || '' },
        });
        return this.getMissionLedger(missionId);
      },
      getMissionLedger(missionId) {
        const ledgers = sqlJson('SELECT * FROM todo_ledgers WHERE mission_id = ?', [missionId]).map(mapLedgerRow),
          todos = !(ledgers.length === 0) ? this.listTodosByMission(missionId) : undefined;
        if (ledgers.length === 0) {
          return [];
        }
        return [{ ...ledgers[0], todos }];
      },
      listMissionLedgers(filters = {}) {
        if (filters.status) {
          assertInSet(filters.status, MISSION_LEDGER_STATUSES, 'status');
        }
        const rows = filters.status
          ? sqlJson('SELECT * FROM todo_ledgers WHERE status = ? ORDER BY updated_at DESC', [filters.status]).map(
              mapLedgerRow,
            )
          : sqlJson('SELECT * FROM todo_ledgers ORDER BY updated_at DESC').map(mapLedgerRow);
        if (rows.length === 0) {
          return [];
        }
        const missionIds = rows.map((ledger) => ledger.missionId),
          placeholders = missionIds.map(() => '?').join(','),
          todosByMission = groupTodosByMission(
            sqlJson(
              `SELECT * FROM todo_items WHERE mission_id IN (${placeholders}) ORDER BY created_at`,
              missionIds,
            ).map(mapTodoRow),
          );
        return rows.map((ledger) => ({
          ...ledger,
          todos: todosByMission.get(ledger.missionId) || [],
        }));
      },
      updateMissionLedger(missionId, patch) {
        const existing = this.getMissionLedger(missionId),
          next = !(existing.length === 0) ? { ...existing[0], ...patch } : undefined;
        if (existing.length === 0) {
          return [];
        }
        assertInSet(next.status, MISSION_LEDGER_STATUSES, 'status');
        sqlRun(
          `UPDATE todo_ledgers SET
          mission_title = ?, status = ?, source_mission = ?, planner_summary = ?,
          acceptance_criteria = ?, constraints_json = ?, assumptions = ?,
          human_questions = ?, updated_at = datetime('now')
         WHERE mission_id = ?`,
          [
            next.missionTitle || '',
            next.status,
            next.sourceMission || '',
            next.plannerSummary || '',
            toJson(next.acceptanceCriteria || []),
            toJson(next.constraints || []),
            toJson(next.assumptions || []),
            toJson(next.humanQuestions || []),
            missionId,
          ],
        );
        this.recordMissionEvent(missionId, { eventType: 'ledger_updated', payload: patch });
        return this.getMissionLedger(missionId);
      },
      setMissionLedgerStatus(missionId, status) {
        assertInSet(status, MISSION_LEDGER_STATUSES, 'status');
        const current = this.getMissionLedger(missionId)[0];
        sqlRun("UPDATE todo_ledgers SET status = ?, updated_at = datetime('now') WHERE mission_id = ?", [
          status,
          missionId,
        ]);
        this.recordMissionEvent(missionId, {
          eventType: 'mission_status_changed',
          payload: { from: current?.status || null, to: status },
        });
        return this.getMissionLedger(missionId);
      },

      // --- Todo Items ---
      createTodo(missionId, todo) {
        const id = todo.id || `td-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          normalized = normalizeTodoInput({ ...todo, id, missionId });
        sqlRun(
          `INSERT INTO todo_items (
          id, mission_id, title, status, type, priority, depends_on, goal,
          scope_json, likely_files, lapis_context_query, acceptance_criteria,
          validation_criteria, test_commands, risk_level, worker_instructions,
          validator_instructions, escalation_rules, evidence_json, confidence,
          assigned_worker_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            normalized.id,
            normalized.missionId,
            normalized.title,
            normalized.status,
            normalized.type,
            normalized.priority,
            toJson(normalized.dependsOn),
            normalized.goal,
            toJson(normalized.scope),
            toJson(normalized.likelyFiles),
            normalized.lapisContextQuery,
            toJson(normalized.acceptanceCriteria),
            toJson(normalized.validationCriteria),
            toJson(normalized.testCommands),
            normalized.riskLevel,
            toJson(normalized.workerInstructions),
            toJson(normalized.validatorInstructions),
            toJson(normalized.escalationRules),
            toJson(normalized.evidence),
            normalized.confidence,
            normalized.assignedWorkerId || null,
          ],
        );
        this.recordTodoEvent(id, {
          eventType: 'todo_created',
          payload: { status: normalized.status, title: normalized.title },
        });
        return this.getTodo(id);
      },
      createTodos(missionId, todos) {
        const created = [];
        for (const todo of todos || []) {
          created.push(...this.createTodo(missionId, todo));
        }
        return created;
      },
      getTodo(todoId) {
        return sqlJson('SELECT * FROM todo_items WHERE id = ?', [todoId]).map(mapTodoRow);
      },
      listTodos(filters = {}) {
        const clauses = [],
          params = [],
          where = (() => {
            if (filters.missionId) {
              clauses.push('mission_id = ?');
              params.push(filters.missionId);
            }
            if (filters.status) {
              assertInSet(filters.status, TODO_STATUSES, 'status');
              clauses.push('status = ?');
              params.push(filters.status);
            }
            if (filters.type) {
              assertInSet(filters.type, TODO_TYPES, 'type');
              clauses.push('type = ?');
              params.push(filters.type);
            }

            return clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
          })();
        return sqlJson(`SELECT * FROM todo_items ${where} ORDER BY created_at`, params).map(mapTodoRow);
      },
      listTodosByMission(missionId) {
        return this.listTodos({ missionId });
      },
      searchTodos(query, filters = {}) {
        const like = `%${query || ''}%`,
          params = [like, like, like, like];
        let missionClause = '';
        if (filters.missionId) {
          missionClause = ' AND mission_id = ?';
          params.push(filters.missionId);
        }
        return sqlJson(
          `SELECT * FROM todo_items
         WHERE (title LIKE ? OR goal LIKE ? OR lapis_context_query LIKE ? OR likely_files LIKE ?)
         ${missionClause}
         ORDER BY updated_at DESC`,
          params,
        ).map(mapTodoRow);
      },
      updateTodo(todoId, patch) {
        const current = this.getTodo(todoId)[0],
          next = current
            ? normalizeTodoInput({ ...current, ...patch, id: todoId, missionId: current.missionId })
            : undefined;
        if (!current) {
          return [];
        }
        validateTodoStatusEvidence(next.status, next.evidence);
        sqlRun(
          `UPDATE todo_items SET
          title = ?, status = ?, type = ?, priority = ?, depends_on = ?, goal = ?,
          scope_json = ?, likely_files = ?, lapis_context_query = ?,
          acceptance_criteria = ?, validation_criteria = ?, test_commands = ?,
          risk_level = ?, worker_instructions = ?, validator_instructions = ?,
          escalation_rules = ?, evidence_json = ?, confidence = ?,
          assigned_worker_id = ?, updated_at = datetime('now')
         WHERE id = ?`,
          [
            next.title,
            next.status,
            next.type,
            next.priority,
            toJson(next.dependsOn),
            next.goal,
            toJson(next.scope),
            toJson(next.likelyFiles),
            next.lapisContextQuery,
            toJson(next.acceptanceCriteria),
            toJson(next.validationCriteria),
            toJson(next.testCommands),
            next.riskLevel,
            toJson(next.workerInstructions),
            toJson(next.validatorInstructions),
            toJson(next.escalationRules),
            toJson(next.evidence),
            next.confidence,
            next.assignedWorkerId || null,
            todoId,
          ],
        );
        this.recordTodoEvent(todoId, { eventType: 'todo_updated', payload: patch });
        return this.getTodo(todoId);
      },
      setTodoStatus(todoId, status) {
        assertInSet(status, TODO_STATUSES, 'status');
        const current = this.getTodo(todoId)[0];
        if (!current) {
          return [];
        }
        validateTodoStatusEvidence(status, current.evidence);
        sqlRun("UPDATE todo_items SET status = ?, updated_at = datetime('now') WHERE id = ?", [status, todoId]);
        this.recordTodoEvent(todoId, {
          eventType: 'todo_status_changed',
          payload: { from: current.status, to: status },
        });
        return this.getTodo(todoId);
      },
      addTodoEvidence(todoId, evidencePatch) {
        const current = this.getTodo(todoId)[0],
          evidence = current ? mergeEvidence(current.evidence, evidencePatch || {}) : undefined;
        if (!current) {
          return [];
        }
        sqlRun("UPDATE todo_items SET evidence_json = ?, updated_at = datetime('now') WHERE id = ?", [
          toJson(evidence),
          todoId,
        ]);
        this.recordTodoEvent(todoId, { eventType: 'todo_evidence_added', payload: evidencePatch || {} });
        return this.getTodo(todoId);
      },
      addTodoNote(todoId, note) {
        return this.addTodoEvidence(todoId, { notes: [note] });
      },
      assignTodo(todoId, workerId) {
        const current = this.getTodo(todoId)[0];
        if (!current) {
          return [];
        }
        sqlRun("UPDATE todo_items SET assigned_worker_id = ?, updated_at = datetime('now') WHERE id = ?", [
          workerId,
          todoId,
        ]);
        this.recordTodoEvent(todoId, {
          eventType: 'todo_assigned',
          payload: { from: current.assignedWorkerId || null, to: workerId || null },
        });
        return this.getTodo(todoId);
      },
      claimNextReadyTodo(missionId, workerId) {
        const rows = sqlJson(
            `UPDATE todo_items
         SET status = 'in_progress',
             assigned_worker_id = ?,
             updated_at = datetime('now')
         WHERE id = (
           SELECT t.id FROM todo_items t
           WHERE t.mission_id = ? AND t.status = 'ready'
             AND (
               COALESCE(json_array_length(t.depends_on), 0) = 0
               OR NOT EXISTS (
                 SELECT 1 FROM json_each(t.depends_on) dep
                 JOIN todo_items blocker ON blocker.id = dep.value
                 WHERE blocker.status NOT IN ('passed', 'merged', 'cancelled', 'implemented')
               )
             )
           ORDER BY
             CASE t.priority
               WHEN 'high' THEN 3
               WHEN 'medium' THEN 2
               WHEN 'low' THEN 1
               ELSE 2
             END DESC,
             t.created_at
           LIMIT 1
         )
         RETURNING *`,
            [workerId, missionId],
          ).map(mapTodoRow),
          todo = !(rows.length === 0) ? rows[0] : undefined;
        if (rows.length === 0) {
          return [];
        }
        this.recordTodoEvent(todo.id, {
          eventType: 'todo_assigned',
          payload: { from: null, to: workerId || null },
        });
        this.recordTodoEvent(todo.id, {
          eventType: 'todo_status_changed',
          payload: { from: 'ready', to: 'in_progress' },
        });
        return this.getTodo(todo.id);
      },
      getTodoContextQuery(todoId) {
        const todo = this.getTodo(todoId)[0];
        if (!todo) {
          return [];
        }
        return [{ todoId, lapisContextQuery: todo.lapisContextQuery }];
      },

      // --- Todo Audit Events ---
      recordTodoEvent(todoId, event) {
        const todo = this.getTodo(todoId)[0],
          id = todo ? event.id || `te-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : undefined;
        if (!todo) {
          return [];
        }
        sqlRun(
          'INSERT INTO todo_events (id, mission_id, todo_id, event_type, actor_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
          [
            id,
            todo.missionId,
            todoId,
            event.eventType || 'todo_event',
            event.actorId || null,
            toJson(event.payload || {}),
          ],
        );
        return sqlJson('SELECT * FROM todo_events WHERE id = ?', [id]).map(mapTodoEventRow);
      },
      listTodoEvents(todoId) {
        return sqlJson('SELECT * FROM todo_events WHERE todo_id = ? ORDER BY created_at', [todoId]).map(
          mapTodoEventRow,
        );
      },
      recordMissionEvent(missionId, event) {
        const id = event.id || `me-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        sqlRun(
          'INSERT INTO todo_events (id, mission_id, todo_id, event_type, actor_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
          [id, missionId, null, event.eventType || 'mission_event', event.actorId || null, toJson(event.payload || {})],
        );
        return sqlJson('SELECT * FROM todo_events WHERE id = ?', [id]).map(mapTodoEventRow);
      },
      listMissionEvents(missionId) {
        return sqlJson('SELECT * FROM todo_events WHERE mission_id = ? ORDER BY created_at', [missionId]).map(
          mapTodoEventRow,
        );
      },

      // --- Checkpoints ---
      createCheckpoint({ id, missionId, trigger, milestoneId, summary }) {
        sqlRun('INSERT INTO checkpoints (id, mission_id, trigger, milestone_id, summary) VALUES (?, ?, ?, ?, ?)', [
          id,
          missionId,
          trigger,
          milestoneId,
          summary,
        ]);
        return sqlJson('SELECT * FROM checkpoints WHERE id = ?', [id]);
      },
      getCheckpoint(id) {
        return sqlJson('SELECT * FROM checkpoints WHERE id = ?', [id]);
      },
      resolveCheckpoint(id, decision, guidance, reason, rescopeGuidance) {
        const existing = sqlJson('SELECT * FROM checkpoints WHERE id = ?', [id]);
        if (existing.length > 0 && existing[0].status === 'resolved') {
          return existing;
        }
        sqlRun(
          "UPDATE checkpoints SET status = 'resolved', decision = ?, guidance = ?, reason = ?, rescope_guidance = ?, resolved_at = datetime('now') WHERE id = ?",
          [decision, guidance || null, reason || null, rescopeGuidance || null, id],
        );
        return sqlJson('SELECT * FROM checkpoints WHERE id = ?', [id]);
      },
      getPendingCheckpoints(missionId) {
        return sqlJson("SELECT * FROM checkpoints WHERE mission_id = ? AND status = 'pending'", [missionId]);
      },

      // --- Mission listing ---
      listMissions(status) {
        if (status) {
          return sqlJson('SELECT * FROM missions WHERE status = ?', [status]);
        }
        return sqlJson('SELECT * FROM missions');
      },
    };

  return Object.freeze(repository);
}

const MISSION_LEDGER_STATUSES = new Set([
    'planning',
    'ready',
    'in_progress',
    'blocked',
    'validating',
    'completed',
    'cancelled',
  ]),
  TODO_STATUSES = new Set([
    'pending',
    'ready',
    'in_progress',
    'blocked',
    'implemented',
    'validating',
    'needs_changes',
    'passed',
    'merged',
    'cancelled',
  ]),
  TODO_TYPES = new Set(['discovery', 'implementation', 'test', 'refactor', 'validation', 'documentation']),
  PRIORITIES = new Set(['low', 'medium', 'high']),
  RISK_LEVELS = new Set(['low', 'medium', 'high']),
  CONFIDENCE_LEVELS = new Set(['low', 'medium', 'high']);

function groupTodosByMission(todos) {
  const map = new Map();
  for (const todo of todos) {
    const existing = map.get(todo.missionId);
    if (existing) {
      existing.push(todo);
    } else {
      map.set(todo.missionId, [todo]);
    }
  }
  return map;
}

function assertInSet(value, allowed, field) {
  if (!allowed.has(value)) {
    throw new Error(`${field} must be one of: ${Array.from(allowed).join(', ')}`);
  }
}

function toJson(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function defaultEvidence() {
  return {
    branch: null,
    commits: [],
    changedFiles: [],
    testsRun: [],
    testResults: [],
    validatorVerdict: null,
    notes: [],
  };
}

function normalizeEvidence(evidence) {
  const base = defaultEvidence(),
    input = evidence && typeof evidence === 'object' ? evidence : {};
  return {
    branch: input.branch ?? base.branch,
    commits: Array.isArray(input.commits) ? input.commits : base.commits,
    changedFiles: Array.isArray(input.changedFiles) ? input.changedFiles : base.changedFiles,
    testsRun: Array.isArray(input.testsRun) ? input.testsRun : base.testsRun,
    testResults: Array.isArray(input.testResults) ? input.testResults : base.testResults,
    validatorVerdict: input.validatorVerdict ?? base.validatorVerdict,
    notes: Array.isArray(input.notes) ? input.notes : base.notes,
  };
}

function mergeEvidence(current, patch) {
  const evidence = normalizeEvidence(current),
    next = patch && typeof patch === 'object' ? patch : {};
  for (const field of ['commits', 'changedFiles', 'testsRun', 'testResults', 'notes']) {
    if (Array.isArray(next[field])) {
      evidence[field] = [...evidence[field], ...next[field]];
    }
  }
  if (Object.hasOwn(next, 'branch')) {
    evidence.branch = next.branch;
  }
  if (Object.hasOwn(next, 'validatorVerdict')) {
    evidence.validatorVerdict = next.validatorVerdict;
  }
  return evidence;
}

function hasEvidence(evidence) {
  const normalized = normalizeEvidence(evidence);
  return Boolean(
    normalized.branch ||
    normalized.validatorVerdict ||
    normalized.commits.length ||
    normalized.changedFiles.length ||
    normalized.testsRun.length ||
    normalized.testResults.length ||
    normalized.notes.length,
  );
}

function validateTodoStatusEvidence(status, evidence) {
  if (status === 'implemented' && !hasEvidence(evidence)) {
    throw new Error('todo cannot be marked implemented without evidence');
  }
  if (status === 'passed' && !normalizeEvidence(evidence).validatorVerdict) {
    throw new Error('todo cannot be marked passed without validator verdict evidence');
  }
  if (status === 'merged') {
    const normalized = normalizeEvidence(evidence);
    if (!normalized.branch || normalized.commits.length === 0) {
      throw new Error('todo cannot be marked merged without branch and commit evidence');
    }
  }
}

function normalizeTodoInput(todo) {
  const normalized = {
    id: todo.id,
    missionId: todo.missionId,
    title: todo.title || todo.goal || 'Untitled todo',
    status: todo.status || 'pending',
    type: todo.type || 'implementation',
    priority: todo.priority || 'medium',
    dependsOn: Array.isArray(todo.dependsOn) ? todo.dependsOn : [],
    goal: todo.goal || '',
    scope:
      todo.scope && typeof todo.scope === 'object'
        ? {
            in: Array.isArray(todo.scope.in) ? todo.scope.in : [],
            out: Array.isArray(todo.scope.out) ? todo.scope.out : [],
          }
        : { in: [], out: [] },
    likelyFiles: Array.isArray(todo.likelyFiles) ? todo.likelyFiles : [],
    lapisContextQuery: todo.lapisContextQuery || '',
    acceptanceCriteria: Array.isArray(todo.acceptanceCriteria) ? todo.acceptanceCriteria : [],
    validationCriteria: Array.isArray(todo.validationCriteria) ? todo.validationCriteria : [],
    testCommands: Array.isArray(todo.testCommands) ? todo.testCommands : [],
    riskLevel: todo.riskLevel || 'medium',
    workerInstructions: Array.isArray(todo.workerInstructions) ? todo.workerInstructions : [],
    validatorInstructions: Array.isArray(todo.validatorInstructions) ? todo.validatorInstructions : [],
    escalationRules: Array.isArray(todo.escalationRules) ? todo.escalationRules : [],
    evidence: normalizeEvidence(todo.evidence),
    confidence: todo.confidence || 'medium',
    assignedWorkerId: todo.assignedWorkerId || todo.assigned_worker_id || null,
  };
  assertInSet(normalized.status, TODO_STATUSES, 'status');
  assertInSet(normalized.type, TODO_TYPES, 'type');
  assertInSet(normalized.priority, PRIORITIES, 'priority');
  assertInSet(normalized.riskLevel, RISK_LEVELS, 'riskLevel');
  assertInSet(normalized.confidence, CONFIDENCE_LEVELS, 'confidence');
  validateTodoStatusEvidence(normalized.status, normalized.evidence);
  return normalized;
}

function mapLedgerRow(row) {
  return {
    missionId: row.mission_id,
    missionTitle: row.mission_title,
    status: row.status,
    sourceMission: row.source_mission,
    plannerSummary: row.planner_summary,
    acceptanceCriteria: parseJson(row.acceptance_criteria, []),
    constraints: parseJson(row.constraints_json, []),
    assumptions: parseJson(row.assumptions, []),
    humanQuestions: parseJson(row.human_questions, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTodoRow(row) {
  return {
    id: row.id,
    missionId: row.mission_id,
    title: row.title,
    status: row.status,
    type: row.type,
    priority: row.priority,
    dependsOn: parseJson(row.depends_on, []),
    goal: row.goal,
    scope: parseJson(row.scope_json, { in: [], out: [] }),
    likelyFiles: parseJson(row.likely_files, []),
    lapisContextQuery: row.lapis_context_query,
    acceptanceCriteria: parseJson(row.acceptance_criteria, []),
    validationCriteria: parseJson(row.validation_criteria, []),
    testCommands: parseJson(row.test_commands, []),
    riskLevel: row.risk_level,
    workerInstructions: parseJson(row.worker_instructions, []),
    validatorInstructions: parseJson(row.validator_instructions, []),
    escalationRules: parseJson(row.escalation_rules, []),
    evidence: normalizeEvidence(parseJson(row.evidence_json, defaultEvidence())),
    confidence: row.confidence,
    assignedWorkerId: row.assigned_worker_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTodoEventRow(row) {
  return {
    id: row.id,
    missionId: row.mission_id,
    todoId: row.todo_id,
    eventType: row.event_type,
    actorId: row.actor_id,
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at,
  };
}

module.exports = { createAurexRepository };
