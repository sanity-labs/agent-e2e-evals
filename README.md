# Agent Evaluation Suite

Test AI coding agents to measure what actually works.

## Prerequisites

- Ensure [mise-config](https://github.com/sanity-io/mise-config) has been set up
- Install 1Password and get access to the "Dev Secrets" vault

## Setup

1. **Install tools and dependencies:**

   ```bash
   mise install
   mise run setup
   ```

2. **Configure secrets:**

   Secrets are managed via [fnox](https://fnox.jdx.dev/) with the 1Password provider. See [`fnox.toml`](fnox.toml) for the full list of secrets.

   Secrets load automatically when you `cd` into the project directory (via the mise + fnox integration). You can verify they're available with:

   ```bash
   fnox export
   ```

## Running Evals

### Preview (no cost)

See what will run without making API calls:

```bash
pnpm agent-eval cc --dry
```

### Run Experiments

Run the Claude Code experiment:

```bash
pnpm agent-eval cc
```

Run the Codex experiment:

```bash
pnpm agent-eval codex
```

### View Results

Launch the web-based results viewer:

```bash
pnpm agent-eval playground
```

Open [http://localhost:3000](http://localhost:3000) to browse results.

## Mise Tasks

| Task                 | Description                                          |
| -------------------- | ---------------------------------------------------- |
| `mise run setup`     | Installs dependencies                                |
| `mise run typecheck` | Runs TypeScript type checking                        |
| `mise run test`      | Runs tests                                           |
| `mise run up`        | Installs dependencies and starts tests in watch mode |
