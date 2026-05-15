const observations = require('../../../../data-access/observations');
const workspaces = require('../../../../data-access/workspaces');

function createMemoryRepository(deps) {
  const repository = {
    insertObservation(params) {
      return observations.insertObservation(deps, params);
    },
    insertObservationRelation(params) {
      return observations.insertObservationRelation(deps, params);
    },
    softDeleteObservation(id) {
      return observations.softDeleteObservation(deps, id);
    },
    hardDeleteObservation(id) {
      return observations.hardDeleteObservation(deps, id);
    },
    getObservation(id) {
      return observations.getObservation(deps, id);
    },
    getSymbolLinksForMemory(memoryId) {
      return observations.getSymbolLinksForMemory(deps, memoryId);
    },
    getRecallCountForMemory(memoryId) {
      return observations.getRecallCountForMemory(deps, memoryId);
    },
    updateObservation(params) {
      return observations.updateObservation(deps, params);
    },
    getTimeline(params) {
      return observations.getTimeline(deps, params);
    },
    insertUserPrompt(params) {
      return observations.insertUserPrompt(deps, params);
    },
    insertCapturePassiveObservation(params) {
      return observations.insertCapturePassiveObservation(deps, params);
    },
    getObservationStats() {
      return observations.getObservationStats(deps);
    },
    countObservationsByProjectAndType(project) {
      return observations.countObservationsByProjectAndType(deps, project);
    },
    insertRecallLog(entries) {
      return observations.insertRecallLog(deps, entries);
    },
    listWorkspaces() {
      return workspaces.listWorkspaces(deps);
    },
    createWorkspace(name) {
      return workspaces.createWorkspace(deps, name);
    },
    archiveWorkspace(name) {
      return workspaces.archiveWorkspace(deps, name);
    },
    listProjects() {
      return workspaces.listProjects(deps);
    },
  };
  return Object.freeze(repository);
}

module.exports = { createMemoryRepository };
