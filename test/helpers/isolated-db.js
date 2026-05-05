const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const STORE = path.resolve(__dirname, '..', '..', 'memory-store.js');
const dbModule = require('../../db');

function createIsolatedTestDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pimem-test-'));
  const dbPath = path.join(tmpDir, 'memory.db');

  dbModule.resetDb(dbPath);
  dbModule.ensureDb();

  const env = { ...process.env, PI_MEMORY_DB_PATH: dbPath };

  function run(cmd) {
    try {
      const out = execSync(`node "${STORE}" ${cmd}`, {
        encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'], env,
      });
      const result = JSON.parse(out.trim());
      return result.data || result;
    } catch (e) {
      if (e.stdout?.trim()) {
        const result = JSON.parse(e.stdout.trim());
        return result.data || result;
      }
      return { error: e.message };
    }
  }

  function cleanup() {
    delete process.env.PI_MEMORY_DB_PATH;
    dbModule.resetDb();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { }
  }

  return { tmpDir, dbPath, env, run, cleanup };
}

function writeTmpRepo(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const FIXTURE_JS = `/** Utility functions */
function add(a, b) {
  return a + b;
}

function subtract(a, b) {
  return a - b;
}

class Calculator {
  constructor() {
    this.result = 0;
  }
  compute(x, y) {
    this.result = add(x, y);
    return this.result;
  }
}

function helper() {
  return 42;
}
`;

const FIXTURE_JS2 = `/** Another module */
import { add } from './utils.js';

function processValue(val) {
  return add(val, 1);
}

function transform(arr) {
  return arr.map(processValue);
}
`;

const FIXTURE_MARKDOWN = `# Getting Started

This is the quickstart guide for the project.

## Installation

Run \`npm install\` to get started. This will install all dependencies.

## Configuration

Create a config file in your home directory.

### Environment Variables

Set PI_MEMORY_DB_PATH to customize the database location.

# API Reference

## save

Saves a memory observation to the database.

## search

Searches for observations matching a query.

# Architecture

## Database Layer

The system uses SQLite for persistence. Data is stored in memory.db.

## Indexing Pipeline

Files are parsed using tree-sitter WASM. Symbols are extracted and indexed.

### Code Analysis

The code analysis module provides import graphs, call hierarchies, and complexity metrics.

# Glossary

- **memory.db** — The SQLite database file
- **observation** — A stored memory entry
- **repo** — An indexed code repository

# Tutorial

## Step 1: Install

First, install the package.

## Step 2: Configure

Next, set up your config.

## Step 3: Use

Finally, start using the memory system.
`;

module.exports = { createIsolatedTestDb, writeTmpRepo, FIXTURE_JS, FIXTURE_JS2, FIXTURE_MARKDOWN };
