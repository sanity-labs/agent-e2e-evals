import { basename } from 'node:path';
import type { EvalRunData, RunCompleteHook } from '@vercel/agent-eval';
import mapObject from 'map-obj';

const SECRET_ENV_VARS = [
  'AI_GATEWAY_API_KEY',
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CURSOR_API_KEY',
  'SANITY_AUTH_TOKEN',
  'SANITY_API_READ_TOKEN',
  'VERCEL_TOKEN',
];

/** Replaces known secrets (read from the environment at call time) with [REDACTED]. */
export function scrubSecrets(value: string): string {
  const secrets = SECRET_ENV_VARS.map((name) => process.env[name]).filter((v): v is string => Boolean(v));
  if (secrets.length === 0) return value;
  return value.replaceAll(new RegExp(secrets.map((s) => RegExp.escape(s)).join('|'), 'g'), '[REDACTED]');
}

/** @vercel/agent-eval hook to redact secrets before results are written to disk. */
export const redactSecrets: RunCompleteHook = ({ config, runData }) => {
  // If copyFiles isn't needed, reduce RAM usage by stripping file contents from the results
  if (config.copyFiles === 'none') {
    runData.generatedFiles = {};
    runData.deletedFiles = [];
  } else {
    // Only the starter saves files (scripts/run.ts). Keep its app/ changes and drop env files
    // outright: their bytes are Buffers, which the string scrubber below never reads.
    // Artifact hygiene only, not a guarantee that saved source holds no secret.
    const keep = (p: string) => p.startsWith('app/') && !basename(p).startsWith('.env');
    runData.generatedFiles = Object.fromEntries(Object.entries(runData.generatedFiles ?? {}).filter(([p]) => keep(p)));
    runData.deletedFiles = (runData.deletedFiles ?? []).filter(keep);
  }

  return mapObject(
    runData as unknown as Record<string, unknown>,
    (key, value) => [key, typeof value === 'string' ? scrubSecrets(value) : value],
    { deep: true },
  ) as unknown as EvalRunData;
};
