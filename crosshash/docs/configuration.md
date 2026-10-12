# CrossHash Configuration

Configuration is layered as defaults, config file, environment variables, then CLI flags.

See `config/default.toml` for all defaults.

Key sections:

- `[ai]`: provider, model, API key env var, gating, auto-accept threshold, cost ceiling.
- `[indexing]`: parallelism, file limits, ignore patterns.
- `[impact]`: traversal confidence threshold and risk thresholds.
- `[output]`: default output format.

Per-repo overrides live in `.crosshash/config.toml` at a registered repository root.
