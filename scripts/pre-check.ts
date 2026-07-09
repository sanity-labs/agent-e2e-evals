#!/usr/bin/env node
import { createClient } from '@sanity/client';

const FIXTURE_ORG_ID = 'oEibUYrzC';
const FIXTURE_PROJECT_ID = 'k6xtz0tk';
const DEFAULT_SANITY_API_HOST = 'https://api.sanity.work';
const SANITY_API_VERSION = '2021-06-07';

const REQUIRED_ENV_VARS = ['SANITY_AUTH_TOKEN'];

let preCheckPromise: Promise<void> | undefined;

function requireEnvVars(): void {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

async function checkSanityAccess(token: string): Promise<void> {
  const apiHost = process.env.SANITY_API_HOST || DEFAULT_SANITY_API_HOST;
  const client = createClient({
    apiHost,
    apiVersion: SANITY_API_VERSION,
    token,
    useCdn: false,
    useProjectHostname: false,
  });

  try {
    await client.users.getById('me');
  } catch (error) {
    throw new Error(`SANITY_AUTH_TOKEN could not authenticate against ${apiHost}`, { cause: error });
  }

  try {
    const projects = await client.projects.list({
      organizationId: FIXTURE_ORG_ID,
      includeMembers: false,
      includeFeatures: false,
    });
    const project = projects.find(({ id }) => id === FIXTURE_PROJECT_ID);

    if (!project) {
      throw new Error(`project ${FIXTURE_PROJECT_ID} was not returned for org ${FIXTURE_ORG_ID}`);
    }
  } catch (error) {
    throw new Error(`SANITY_AUTH_TOKEN cannot access org ${FIXTURE_ORG_ID}`, { cause: error });
  }

  try {
    const project = await client.projects.getById(FIXTURE_PROJECT_ID);
    if (project.organizationId !== FIXTURE_ORG_ID) {
      throw new Error(`expected org ${FIXTURE_ORG_ID}, got ${project.organizationId ?? 'none'}`);
    }
  } catch (error) {
    throw new Error(`SANITY_AUTH_TOKEN cannot access project ${FIXTURE_PROJECT_ID}`, { cause: error });
  }
}

export async function runPreCheck(): Promise<void> {
  requireEnvVars();
  await checkSanityAccess(process.env.SANITY_AUTH_TOKEN!);
}

export async function runPreCheckOnce(): Promise<void> {
  preCheckPromise ??= runPreCheck();
  return preCheckPromise;
}

if (import.meta.main) {
  try {
    console.log('Running eval pre-check...');
    await runPreCheck();
    console.log('[ok] Required env vars are defined.');
    console.log(`[ok] Sanity auth can access org ${FIXTURE_ORG_ID} and project ${FIXTURE_PROJECT_ID}.`);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
