import type { EvalRunData, RunCompleteHook } from '@vercel/agent-eval';
import mapObject from 'map-obj';

// Secrets from CI configs and fnox.toml
const SECRET_ENV_VARS = [
  'AI_GATEWAY_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CURSOR_API_KEY',
  'SANITY_AUTH_TOKEN',
  'VERCEL_TOKEN',
];

const secrets = SECRET_ENV_VARS.map((name) => process.env[name]).filter((value): value is string => Boolean(value));
const secretsRegExp =
  secrets.length > 0 ? new RegExp(secrets.map((secret) => RegExp.escape(secret)).join('|'), 'g') : undefined;

/** Replaces occurrences of known secrets in a given string with [REDACTED]. */
export function scrubSecrets(value: string): string {
  return secretsRegExp ? value.replaceAll(secretsRegExp, '[REDACTED]') : value;
}

/** @vercel/agent-eval hook to redact secrets before results are written to disk. */
export const redactSecrets: RunCompleteHook = ({ config, runData }) => {
  // If copyFiles isn't needed, reduce RAM usage by stripping file contents from the results
  if (config.copyFiles === 'none') {
    runData.generatedFiles = {};
    runData.deletedFiles = [];
  }

  if (!secretsRegExp) return runData;

  return mapObject(
    runData as unknown as Record<string, unknown>,
    (key, value) => [key, typeof value === 'string' ? scrubSecrets(value) : value],
    { deep: true },
  ) as unknown as EvalRunData;
};
