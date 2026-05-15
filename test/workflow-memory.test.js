const workflowMemory = require('../src/workflow-memory');
const scoring = require('../src/workflow-memory/scoring');
const steps = require('../src/workflow-memory/steps');

function mockWorkflowRepository(overrides = {}) {
  return {
    insertWorkflow: vi.fn(),
    upsertStep: vi.fn(),
    recordStepSuccess: vi.fn(),
    recordStepFailure: vi.fn(),
    findStepOutcome: vi.fn(() => []),
    findWorkflow: vi.fn(() => []),
    listWorkflowSteps: vi.fn(() => []),
    ...overrides,
  };
}

describe('workflow-memory', () => {
  describe('workflows', () => {
    it('saves workflow metadata and normalized ordered steps without observation search deps', () => {
      const workflowRepository = mockWorkflowRepository();
      const result = workflowMemory.saveWorkflow(
        { workflowRepository, jsonErrNoExit: vi.fn((message) => ({ error: message })) },
        { id: 'wf-1', name: 'Deploy', project: 'lapis', stepsRaw: 'build\\ntest\n\nship' },
      );

      expect(result).toEqual({ ok: true, stepsSaved: 3 });
      expect(workflowRepository.insertWorkflow).toHaveBeenCalledWith({ id: 'wf-1', name: 'Deploy', project: 'lapis' });
      expect(workflowRepository.upsertStep).toHaveBeenNthCalledWith(1, {
        workflow: 'wf-1',
        stepNum: 1,
        command: 'build',
        success: 1.0,
        attempts: 1,
      });
      expect(workflowRepository.upsertStep).toHaveBeenNthCalledWith(3, {
        workflow: 'wf-1',
        stepNum: 3,
        command: 'ship',
        success: 1.0,
        attempts: 1,
      });
    });

    it('gets workflow metadata with ordered steps from workflow storage only', () => {
      const workflowRepository = mockWorkflowRepository({
        findWorkflow: vi.fn(() => [{ id: 'wf-1', name: 'Deploy', project: 'lapis' }]),
        listWorkflowSteps: vi.fn(() => [{ workflow: 'wf-1', step_num: 1, command: 'build' }]),
      });

      const result = workflowMemory.getWorkflow(
        { workflowRepository, jsonErrNoExit: vi.fn((message) => ({ error: message })) },
        { id: 'wf-1' },
      );

      expect(result.steps).toHaveLength(1);
      expect(workflowRepository.findWorkflow).toHaveBeenCalledWith('wf-1');
      expect(workflowRepository.listWorkflowSteps).toHaveBeenCalledWith('wf-1');
    });
  });

  describe('steps', () => {
    it('records a step with the initial success score and attempts', () => {
      const workflowRepository = mockWorkflowRepository();
      const result = workflowMemory.recordStep(
        { workflowRepository, jsonErrNoExit: vi.fn((message) => ({ error: message })) },
        { workflow: 'wf-1', step: '2', command: 'test' },
      );

      expect(result).toEqual({ ok: true });
      expect(workflowRepository.upsertStep).toHaveBeenCalledWith({
        workflow: 'wf-1',
        stepNum: 2,
        command: 'test',
        success: 1.0,
        attempts: 1,
      });
    });

    it('records successful outcomes and returns attempts from storage', () => {
      const workflowRepository = mockWorkflowRepository({
        findStepOutcome: vi.fn(() => [{ success: 1.0, attempts: 3, fail_workaround: null }]),
      });

      const result = workflowMemory.stepOutcome(
        { workflowRepository, jsonErrNoExit: vi.fn((message) => ({ error: message })) },
        { workflow: 'wf-1', step: 2, success: true },
      );

      expect(result).toEqual({ ok: true, success: 1.0, attempts: 3, fail_workaround: null });
      expect(workflowRepository.recordStepSuccess).toHaveBeenCalledWith({ workflow: 'wf-1', stepNum: 2 });
      expect(workflowRepository.findStepOutcome).toHaveBeenCalledWith({ workflow: 'wf-1', stepNum: 2 });
    });

    it('records failed outcomes with workarounds', () => {
      const workflowRepository = mockWorkflowRepository({
        findStepOutcome: vi.fn(() => [{ success: 0.8, attempts: 2, fail_workaround: 'retry with --force' }]),
      });

      const result = workflowMemory.stepOutcome(
        { workflowRepository, jsonErrNoExit: vi.fn((message) => ({ error: message })) },
        { workflow: 'wf-1', step: 2, success: false, workaround: 'retry with --force' },
      );

      expect(result.fail_workaround).toBe('retry with --force');
      expect(workflowRepository.recordStepFailure).toHaveBeenCalledWith({
        workflow: 'wf-1',
        stepNum: 2,
        workaround: 'retry with --force',
      });
    });

    it('normalizes literal and real newlines in workflow step input', () => {
      expect(steps.parseWorkflowSteps('one\\ntwo\nthree')).toEqual(['one', 'two', 'three']);
    });
  });

  describe('scoring', () => {
    it('calculates bounded success and failure score transitions', () => {
      expect(scoring.scoreStepOutcome({ currentSuccess: 0.95, currentAttempts: 1, success: true })).toEqual({
        success: 1.0,
        attempts: 2,
      });
      expect(scoring.scoreStepOutcome({ currentSuccess: 0.1, currentAttempts: 4, success: false })).toEqual({
        success: 0.0,
        attempts: 5,
      });
    });
  });
});
