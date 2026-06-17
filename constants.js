/**
 * Constants.js — Centralized named constants for the LaPis Memory Layer
 *
 * Replaces magic numbers scattered throughout the codebase with
 * self-documenting, centralized constants organized by domain.
 */

const TRUST_DELTA = {
  SYMBOL_CHANGED: -0.3,
  SURVIVED_UNCHANGED: 0.05,
  PASSIVE_SURVIVAL: 0.1,
  STEP_SUCCESS: 0.1,
  STEP_FAILURE: -0.2,
  STALE_TRUST_DECAY: -0.05,
  DEFAULT_INITIAL: 0.7,
  MAX_SURVIVED: 0.95,
  TRUST_FLOOR: 0.0,
  TRUST_CEILING: 1.0,
};

const DEDUP = {
  AUTO_MERGE_THRESHOLD: 0.85,
  WARNING_THRESHOLD: 0.6,
  DREAM_SUPERSEDED_CONFIDENCE: 0.6,
  DREAM_LOW_TRUST_THRESHOLD: 0.3,
  MARK_DUP_DEFAULT_CONFIDENCE: 0.9,
};

const TIME_WINDOWS = {
  ARCHIVE_INACTIVE_DAYS: 90,
  PURGE_SOFT_DELETED_DAYS: 30,
  DREAM_AUTO_DETECTED_MIN_AGE_DAYS: 7,
  RECOVERY_RECENT_MINUTES: 5,
  RECENCY_HALF_LIFE_MS: 7 * 24 * 60 * 60 * 1000,
  CHURN_DEFAULT_WINDOW_DAYS: 90,
  TRUST_ADJUSTMENTS_RETENTION_DAYS: 90,
  WORKFLOW_RETENTION_DAYS: 90,
};

const RESULT_LIMITS = {
  SEARCH_MULTIPLIER: 3,
  SEARCH_MAX_ROWS: 50,
  DEDUP_CANDIDATES: 20,
  RELATED_PER_SYMBOL: 5,
  RECENT_SESSIONS: 5,
  PERSONAL_OBSERVATIONS: 3,
  SUMMARIES_PER_PROJECT: 3,
  SESSION_SUMMARY_FLOOR: 1,
  PROMPTS_PER_PROJECT: 10,
  SESSIONS_PER_PROJECT: 10,
  DEFAULT_SEARCH_LIMIT: 10,
  DEFAULT_CODE_SEARCH_RESULTS: 20,
  IMPORT_GRAPH_MAX: 500,
  PROVENANCE_MAX_COMMITS: 50,
  CHURN_TOP_FILES: 50,
  DOC_SEARCH_LIMIT: 20,
  DOC_CODE_EXAMPLES_LIMIT: 10,
  DOC_COVERAGE_LIST_LIMIT: 20,
  OUTLINE_SUGGESTION_LIMIT: 20,
  DOC_BATCH_SIZE: 50,
  INDEX_BATCH_SIZE: 50,
  WINNOW_DEFAULT_TOP: 20,
  IMPORTANCE_DEFAULT_TOP: 20,
  HOTSPOTS_DEFAULT_TOP: 20,
  AST_PATTERNS_DEFAULT_LIMIT: 200,
  CALL_HIERARCHY_DEFAULT_DEPTH: 3,
  BLAST_RADIUS_DEFAULT_DEPTH: 3,
  SIGNAL_CHAINS_DEFAULT_DEPTH: 5,
};

const RANKING = {
  DEFAULT_TRUST_SCORE: 0.7,
  RECALL_LOG_MULTIPLIER: 0.2,
  USEFULNESS_MULTIPLIER: 0.15,
  WORD_OVERLAP_BOOST: 2,
  MIN_WORD_LENGTH: 1,
  TYPE_PRIORITY: {
    decision: 3,
    architecture: 3,
    bugfix: 2,
    pattern: 2,
    preference: 2,
    config: 1,
    discovery: 1,
    learning: 1,
    session_summary: 0,
    skill: 0,
    progress: -1,
    accomplished: -1,
  },
  TYPE_BOOST: {
    decision: 1.3,
    architecture: 1.3,
    bugfix: 1.2,
    pattern: 1.2,
    preference: 1.2,
    config: 1.1,
    discovery: 1.0,
    learning: 1.0,
    session_summary: 0.7,
    skill: 0.5,
  },
  NAVIGATION_QUERY_SIGNALS: ['where', 'module', 'file', 'hook', 'wired', 'location', 'path', 'lives', 'implemented'],
  NAVIGATION_BOOST: {
    path_pattern: /(?:src\/|extensions\/|lib\/|[\w-]+\/[\w-]+\.[\w]+|\.[\w]+\/)/,
    path_multiplier: 1.5,
  },
};

const CONTEXT = {
  RELEVANCE_WEIGHTS: {
    recall: 0.35,
    trust: 0.25,
    recency: 0.25,
    typePriority: 0.15,
  },
  CROSS_PROJECT_DEEP_MULTIPLIER: 2,
  CROSS_PROJECT_DEEP_MAX: 30,
  CROSS_PROJECT_SUPPLEMENT_LIMIT: 3,
  TOPIC_MATCH_BOOST: 5,
  EXCLUDED_TYPES: ['progress', 'accomplished', 'session_summary'],
  DEFAULT_LIMIT: 10,
  PROMPT_RELEVANT_LIMIT: 3,
  PROJECT_SUMMARY_LIMIT: 1,
  PROMPT_INJECT_LIMIT: 1,
  NAVIGATION_PROMPT_INJECT_LIMIT: 2,
  PERSONAL_INJECT_LIMIT: 0,
  MIN_OBSERVATION_TRUST: 0.8,
  PROMPT_MEMORY_SNIPPET_LENGTH: 180,
  PROJECT_SUMMARY_LENGTH: 180,
  MAX_INJECTED_CONTEXT_CHARS: 1800,
  STALE_GUIDANCE:
    '📝 **Stale code index:** indexed code may not match current source files. Run `memory-code reindex-repo --repo {repo}` to update. Verify current source before relying on code-index results.',
  PREFLIGHT_CODE_LIMIT: 3,
  PREFLIGHT_MEMORY_LIMIT: 2,
  PREFLIGHT_DOC_LIMIT: 1,
  PREFLIGHT_MAX_CHARS: 400,
  PREFLIGHT_RELATED_FILES: 3,
  TOKEN_BUDGET_DEFAULT: 2000,
  TOKEN_BUDGET_MIN: 500,
  TOKEN_BUDGET_HEADROOM: 0.3,
  TRUNCATE_CONTENT_CHARS: 100,
  HEADERS_ONLY_LIMIT: 3,
  NEVER_TRUNCATE_TYPES: ['decision', 'architecture'],
};

const PAGERANK = {
  DAMPING_FACTOR: 0.85,
  ITERATIONS: 10,
  MAX_CACHE_SIZE: 8,
};

const HOTSPOT_THRESHOLDS = {
  CRITICAL: 20,
  HIGH: 10,
  MEDIUM: 5,
};

const PR_RISK = {
  WEIGHTS: {
    blast_radius: 0.3,
    complexity: 0.2,
    churn: 0.2,
    test_coverage: 0.2,
    change_volume: 0.1,
  },
  BLAST_RADIUS_NORMALIZER: 50,
  COMPLEXITY_NORMALIZER: 30,
  CHURN_NORMALIZER: 20,
  CHANGE_VOLUME_NORMALIZER: 500,
  RISK_LEVELS: {
    LOW: 0.3,
    MEDIUM: 0.6,
    HIGH: 0.8,
  },
};

const DEAD_CODE = {
  NO_CALLERS_WEIGHT: 0.33,
  UNREACHABLE_FILE_WEIGHT: 0.34,
  RE_EXPORTED_PENALTY: 0.34,
  DEFAULT_MIN_CONFIDENCE: 0.5,
};

const COMPLEXITY = {
  LOW_THRESHOLD: 4,
  MEDIUM_THRESHOLD: 10,
};

const COUPLING = {
  STABLE_THRESHOLD: 0.3,
  UNSTABLE_THRESHOLD: 0.7,
};

const FRESHNESS_CACHE_TTL_MS = 60_000;

const CONFIDENCE_DEFAULTS = {
  UNKNOWN_TOOL: 0.5,
  DETERMINISTIC_TOOL: 1.0,
};

const UNDETECTED_CONFIDENCE = {
  INDIRECTLY_TESTED: 0.4,
  TEST_IMPORTED_FILE: 0.7,
  NO_TEST_SIGNAL: 1.0,
};

const CAPTURE_PASSIVE = {
  SUMMARY_MAX_LENGTH: 80,
};

const WORKER_POOL = {
  MIN_FILES_FOR_PARALLEL: 50,
  MAX_WORKERS: 4,
};

const CALL_GRAPH = {
  MAX_FILE_CONTENT_BYTES: 2_000_000,
  PROGRESS_INTERVAL_FILES: 50,
};

const DUPLICATE_DETECTION = {
  MIN_BODY_LENGTH: 40,
  MINHASH_PERMUTATIONS: 128,
  SIMILARITY_THRESHOLD: 0.65,
  SHINGLE_SIZE: 4,
  TOP_K_GROUPS: 20,
  NAME_SIMILARITY_THRESHOLD: 0.6,
  // LSH banding: replace O(n^2) pairwise MinHash comparison with candidate
  // generation via band buckets. rowsPerBand=4 → 32 bands for 128 permutations,
  // giving ~99.8% recall at the 0.65 threshold while collapsing the all-pairs
  // scan. Exact Jaccard is still applied to every candidate pair, so the
  // reported threshold is unaffected.
  LSH_ROWS_PER_BAND: 4,
};

const AUDIT_DIFF = {
  MAX_FILES: 50,
  VIOLATION_TYPES: [
    'duplicate_creation',
    'unused_import_added',
    'hot_path_modified',
    'untested_public_api',
    'constraint_violation',
    'existing_service_ignored',
  ],
  RISK_WEIGHTS: {
    duplicate: 0.30,
    hot_path: 0.25,
    untested: 0.20,
    constraint: 0.15,
    ignored_service: 0.10,
  },
  RISK_LEVELS: {
    LOW: 0.3,
    MEDIUM: 0.6,
    HIGH: 0.8,
  },
};

const SYMBOL_ENRICHMENT = {
  MIN_SYMBOLS: 10,
  BATCH_SIZE: 100,
  MAX_INTENT_LENGTH: 200,
  MAX_CONSTRAINT_LENGTH: 300,
};

module.exports = {
  TRUST_DELTA,
  DEDUP,
  TIME_WINDOWS,
  RESULT_LIMITS,
  RANKING,
  CONTEXT,
  PAGERANK,
  HOTSPOT_THRESHOLDS,
  PR_RISK,
  DEAD_CODE,
  COMPLEXITY,
  COUPLING,
  FRESHNESS_CACHE_TTL_MS,
  CONFIDENCE_DEFAULTS,
  UNDETECTED_CONFIDENCE,
  CAPTURE_PASSIVE,
  WORKER_POOL,
  CALL_GRAPH,
  DUPLICATE_DETECTION,
  AUDIT_DIFF,
  SYMBOL_ENRICHMENT,
};
