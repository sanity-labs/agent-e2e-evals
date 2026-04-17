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

   Commands that need secrets are wrapped with `fnox exec` (see `mise run up`). You can verify secrets are accessible with:

   ```bash
   fnox export
   ```

## Running Experiments

Each file in `experiments/` defines a configuration for an agent + model combination. Run a specific experiment by name (filename without `.ts`):

```bash
pnpm agent-eval claude-opus-4.6
```

Run all experiments:

```bash
pnpm agent-eval
```

Preview what would run without making API calls:

```bash
pnpm agent-eval --dry
```

## mise Tasks

| Task                 | Description                                          |
| -------------------- | ---------------------------------------------------- |
| `mise run setup`     | Installs dependencies                                |
| `mise run typecheck` | Runs TypeScript type checking                        |
| `mise run test`      | Runs tests                                           |
| `mise run up`        | Installs dependencies and starts tests in watch mode |
