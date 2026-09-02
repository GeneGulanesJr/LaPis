const { listWorkspaces, createWorkspace, archiveWorkspace, listProjects } = require('../src/memory-domain/workspaces');

function mockDeps() {
  return { sqlJson: vi.fn(), sqlRun: vi.fn(), sqlRaw: vi.fn(), ensureDb: vi.fn() };
}

describe('data-access/workspaces', () => {
  describe('listWorkspaces', () => {
    it('should return workspaces with counts', () => {
      const deps = mockDeps(),
        result = (() => {
          deps.sqlJson.mockReturnValue([{ id: 1, name: 'proj1', created_at: '2024-01-01', memory_count: 5 }]);

          return listWorkspaces(deps);
        })();
      expect(result.workspaces.length).toBe(1);
      expect(result.total).toBe(1);
    });
  });

  describe('createWorkspace', () => {
    it('should create a workspace and return it', () => {
      const deps = mockDeps(),
        result = (() => {
          deps.sqlJson.mockReturnValue([{ id: 1, name: 'test', created_at: '2024-01-01' }]);

          return createWorkspace(deps, 'test');
        })();
      expect(result.success).toBe(true);
      expect(result.workspace.name).toBe('test');
    });

    it('should return error for missing name', () => {
      const result = createWorkspace(mockDeps(), '');
      expect(result.error).toContain('Missing');
    });

    it('should return error if workspace already exists', () => {
      const deps = mockDeps(),
        result = (() => {
          deps.sqlRun.mockImplementation(() => {
            throw new Error('UNIQUE constraint');
          });

          return createWorkspace(deps, 'existing');
        })();
      expect(result.error).toContain('already exists');
    });
  });

  describe('archiveWorkspace', () => {
    it('should archive an existing workspace', () => {
      const deps = mockDeps(),
        result = (() => {
          deps.sqlJson.mockReturnValue([{ id: 1 }]);

          return archiveWorkspace(deps, 'proj1');
        })();
      expect(result.success).toBe(true);
      expect(result.archived).toBe(true);
    });

    it('should return error for non-existent workspace', () => {
      const deps = mockDeps(),
        result = (() => {
          deps.sqlJson.mockReturnValue([]);

          return archiveWorkspace(deps, 'nonexistent');
        })();
      expect(result.error).toContain('not found');
    });

    it('should return error for missing name', () => {
      const result = archiveWorkspace(mockDeps(), '');
      expect(result.error).toContain('Missing');
    });
  });

  describe('listProjects', () => {
    it('should return projects with counts', () => {
      const deps = mockDeps(),
        result = (() => {
          deps.sqlJson.mockReturnValue([{ project: 'myproj', memory_count: 10, last_active: '2024-01-01' }]);

          return listProjects(deps);
        })();
      expect(result.projects.length).toBe(1);
    });
  });
});
