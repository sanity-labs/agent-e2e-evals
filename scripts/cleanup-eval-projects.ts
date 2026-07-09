#!/usr/bin/env node
import { parseArgs } from 'node:util';
/**
 * Clean up Sanity projects that were created during eval runs.
 *
 * Defaults to dry-run. Pass `--delete` to delete the selected projects.
 */
import { anthropic } from '@ai-sdk/anthropic';
import { createClient } from '@sanity/client';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { EVAL_DISPLAY_NAMES } from './common.ts';
import { loginServiceAccount } from './sanity-service-account-auth.ts';

const MODEL = 'claude-haiku-4-5';
const REASONING = 'low';
const FIXTURE_ORG_ID = 'oEibUYrzC';

// Add project IDs that should never be deleted here.
const NEVER_DELETE_PROJECT_IDS = [
  'k6xtz0tk',
  'ewarjnkq',
  '43szst9a',
  '6yyzwg5d',
  '5rqpul29',
  'lpvyeh0h',
  'wex57hrk',
  'a4ksoktz',
  '2bp02lrc',
  'zloxk6xx',
  'ewarjnkq',
  'ikw3sn6k',
  'edsoi7in',
  'hqrr0b0k',
  'pi46dew1',
] as const;

// Add exact project display names that should always be deleted here.
const ALWAYS_DELETE_PROJECT_NAMES = [
  'Sanity Next.js App Router Starter',
  'sanity-nextjs-starter',
  'Next.js Starter',
  'Sanity Next Starter',
  'Sanity Nextjs Starter',
  'Sanity Next.js Starter',
  'Next.js App Router Starter',
] as const;

interface Project {
  id: string;
  displayName: string;
}
const cleanupDecisionSchema = z.object({
  projectId: z.string(),
  shouldDelete: z.boolean(),
  reason: z.string(),
});

const cleanupDecisionsSchema = z.object({
  decisions: z.array(cleanupDecisionSchema),
});

type CleanupDecision = z.infer<typeof cleanupDecisionSchema>;
type ProjectCleanupGroup = 'mustNotDelete' | 'mustDelete' | 'needsLlm';

const { values } = parseArgs({
  options: {
    delete: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`Usage: pnpm cleanup-eval-projects [--delete]

Environment:
  EVALS_SERVICE_ACCOUNT_EMAIL       Service account email for Sanity login.
  EVALS_SERVICE_ACCOUNT_PASSWORD    Service account password for Sanity login.
  RECAPTCHA_BYPASS_KEY              reCAPTCHA bypass key for staging login.
  ANTHROPIC_API_KEY                 Anthropic API key.
  DRY=true                          Force dry-run mode, even with --delete.
`);
  process.exit(0);
}

const parsedEnv = z
  .looseObject({
    ANTHROPIC_API_KEY: z.string(),
    EVALS_SERVICE_ACCOUNT_EMAIL: z.string(),
    EVALS_SERVICE_ACCOUNT_PASSWORD: z.string(),
    RECAPTCHA_BYPASS_KEY: z.string(),
    SANITY_API_HOST: z.url(),
    DRY: z.stringbool().optional(),
  })
  .parse(process.env);

const shouldDelete = values.delete && parsedEnv.DRY !== true;
const protectedProjectIds: ReadonlySet<string> = new Set(NEVER_DELETE_PROJECT_IDS);
const alwaysDeleteProjectNames: ReadonlySet<string> = new Set(ALWAYS_DELETE_PROJECT_NAMES);

console.log(`Logging in as service account ${parsedEnv.EVALS_SERVICE_ACCOUNT_EMAIL}...`);
const sanityAuthToken = await loginServiceAccount({
  email: parsedEnv.EVALS_SERVICE_ACCOUNT_EMAIL,
  password: parsedEnv.EVALS_SERVICE_ACCOUNT_PASSWORD,
  recaptchaBypassKey: parsedEnv.RECAPTCHA_BYPASS_KEY,
  apiHost: parsedEnv.SANITY_API_HOST,
});
console.log('Service account login successful.');

const sanityClient = createClient({
  apiHost: parsedEnv.SANITY_API_HOST,
  apiVersion: '2021-06-07',
  token: sanityAuthToken,
  useCdn: false,
  useProjectHostname: false,
});

async function listProjects(): Promise<Project[]> {
  const projects = await sanityClient.projects.list({
    organizationId: FIXTURE_ORG_ID,
    includeMembers: false,
    includeFeatures: false,
  });

  return projects
    .map(({ id, displayName }) => ({ id, displayName }))
    .toSorted((a, b) => {
      return a.displayName.localeCompare(b.displayName);
    });
}

async function classifyProjects(projects: Project[]): Promise<z.infer<typeof cleanupDecisionsSchema>['decisions']> {
  const projectIds = new Set(projects.map((project) => project.id));
  const { output } = await generateText({
    model: anthropic(MODEL),
    reasoning: REASONING,
    output: Output.object({ schema: cleanupDecisionsSchema }),
    instructions: [
      'Review a list of Sanity projects and decide which ones should be deleted.',
      'Projects that were automatically created as part of our automated eval suite should be marked for removal.',
      'Projects created manually by humans should be left alone.',
      'When in doubt, err on the side of caution.',
      'Our eval suite consists of the following prompts:',
      ...Object.values(EVAL_DISPLAY_NAMES),
    ].join('\n'),
    prompt: JSON.stringify(
      {
        fixtureOrganizationId: FIXTURE_ORG_ID,
        projects,
      },
      null,
      2,
    ),
  });

  const seenIds = new Set<string>();
  for (const decision of output.decisions) {
    if (!projectIds.has(decision.projectId)) {
      throw new Error(`LLM returned unknown project ID: ${decision.projectId}`);
    }
    if (seenIds.has(decision.projectId)) {
      throw new Error(`LLM returned duplicate project ID: ${decision.projectId}`);
    }
    seenIds.add(decision.projectId);
  }

  for (const project of projects) {
    if (!seenIds.has(project.id)) {
      throw new Error(`LLM omitted project ID: ${project.id}`);
    }
  }

  return output.decisions;
}

async function deleteProject(projectId: string): Promise<void> {
  await sanityClient.request({ method: 'DELETE', uri: `/projects/${projectId}` });
}

const projects = await listProjects();
console.log(`Found ${projects.length} projects in fixture org ${FIXTURE_ORG_ID}.`);
for (const project of projects) {
  console.log(`- ${project.id} ${project.displayName}`);
}

if (projects.length === 0) {
  process.exit(0);
}

const projectsById = new Map(projects.map((project) => [project.id, project]));
const projectGroups = Object.groupBy(projects, (project): ProjectCleanupGroup => {
  if (protectedProjectIds.has(project.id)) {
    return 'mustNotDelete';
  }

  if (alwaysDeleteProjectNames.has(project.displayName)) {
    return 'mustDelete';
  }

  return 'needsLlm';
});
const mustNotDeleteProjects = projectGroups.mustNotDelete ?? [];
const mustDeleteProjects = projectGroups.mustDelete ?? [];
const projectsToClassify = projectGroups.needsLlm ?? [];

const hardcodedDecisions: CleanupDecision[] = [
  ...mustNotDeleteProjects.map((project) => ({
    projectId: project.id,
    shouldDelete: false,
    reason: 'Project ID is hardcoded as never delete.',
  })),
  ...mustDeleteProjects.map((project) => ({
    projectId: project.id,
    shouldDelete: true,
    reason: 'Project display name is hardcoded as always delete.',
  })),
];

console.log(
  `Skipping Claude classification for ${hardcodedDecisions.length} projects covered by hardcoded cleanup policy.`,
);

let classifiedDecisions: CleanupDecision[] = [];
if (projectsToClassify.length > 0) {
  console.log(`Classifying ${projectsToClassify.length} projects with ${MODEL} (${REASONING} reasoning)`);
  classifiedDecisions = await classifyProjects(projectsToClassify);
}

const decisionsById = new Map(
  [...hardcodedDecisions, ...classifiedDecisions].map((decision) => [decision.projectId, decision]),
);
const finalDecisions = projects.map((project) => {
  const decision = decisionsById.get(project.id);
  if (!decision) {
    throw new Error(`Missing cleanup decision for project ID: ${project.id}`);
  }

  return decision;
});
const projectsToDelete = finalDecisions.filter((decision) => decision.shouldDelete);

console.log('');
console.log(`Selected ${projectsToDelete.length}/${projects.length} projects for deletion.`);
for (const decision of projectsToDelete) {
  const project = projectsById.get(decision.projectId);
  console.log(`- ${decision.projectId} ${project?.displayName ?? '(unknown name)'}: ${decision.reason}`);
}

if (!shouldDelete) {
  console.log('');
  console.log('Dry run only. Pass --delete to delete the selected projects.');
  process.exit(0);
}

for (const decision of projectsToDelete) {
  const project = projectsById.get(decision.projectId);
  console.log(`Deleting ${decision.projectId} ${project?.displayName ?? '(unknown name)'}`);
  await deleteProject(decision.projectId);
}

console.log(`Deleted ${projectsToDelete.length} projects.`);
