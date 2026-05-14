const wsDA = require('../data-access/workspaces');

function listWorkspaces(deps) {
  return wsDA.listWorkspaces(deps);
}

function createWorkspace(deps, args) {
  const name = args.name;
  if (!name) {
    return { error: 'Missing --name' };
  }
  return wsDA.createWorkspace(deps, name);
}

function archiveWorkspace(deps, args) {
  const name = args.name;
  if (!name) {
    return { error: 'Missing --name' };
  }
  return wsDA.archiveWorkspace(deps, name);
}

function listProjects(deps) {
  return wsDA.listProjects(deps);
}

module.exports = { listWorkspaces, createWorkspace, archiveWorkspace, listProjects };