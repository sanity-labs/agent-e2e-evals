import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: [
    // Experiment configs loaded by agent-eval
    'experiments/*.ts',

    // Eval test files discovered by agent-eval
    'evals/*/EVAL.ts',
  ],
  // Used by graders added in later layers of this stack.
  ignoreDependencies: ['cheerio'],
  // Make sure eval fixtures aren't considered part of the project
  project: ['experiments/**/*.ts', 'scripts/**/*.ts', 'evals/*/EVAL.ts', '*.ts'],
};

export default config;
