import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: [
    // Experiment configs loaded by agent-eval
    'experiments/*.ts',

    // Eval test files discovered by agent-eval
    'evals/*/EVAL.ts',
  ],
  // Make sure eval fixtures aren't considered part of the project
  project: ['experiments/**/*.ts', 'scripts/**/*.ts', 'evals/*/EVAL.ts', '*.ts'],
};

export default config;
