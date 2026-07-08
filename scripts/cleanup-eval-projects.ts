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

const FIXTURE_ORG_ID = process.env.SANITY_EVAL_ORGANIZATION_ID ?? 'oEibUYrzC';
const PINNED_PROJECT_ID = process.env.SANITY_EVAL_PROJECT_ID ?? 'k6xtz0tk';
const MODEL = 'claude-haiku-4-5';
const SANITY_API_HOST =
  process.env.SANITY_INTERNAL_ENV === 'production' ? 'https://api.sanity.io' : 'https://api.sanity.work';

// Add project IDs that should never be deleted here.
const NEVER_DELETE_PROJECT_IDS = [PINNED_PROJECT_ID, 'ewarjnkq', '43szst9a', '6yyzwg5d'];

// Add exact project display names that should always be deleted here.
const ALWAYS_DELETE_PROJECT_NAMES = [
  'Sanity Next.js App Router Starter',
  'sanity-nextjs-starter',
  'Next.js Starter',
  'Sanity Next Starter',
  'Sanity Nextjs Starter',
  'Sanity Next.js Starter',
];

interface Project {
  id: string;
  displayName: string;
}

const cleanupDecisionSchema = z.object({
  decisions: z.array(
    z.object({
      projectId: z.string(),
      shouldDelete: z.boolean(),
      reason: z.string(),
    }),
  ),
});

const { values } = parseArgs({
  options: {
    delete: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`Usage: pnpm cleanup-eval-projects [--delete]

Environment:
  SANITY_AUTH_TOKEN              Required Sanity token.
  ANTHROPIC_API_KEY              Required Anthropic API key.
  SANITY_EVAL_ORGANIZATION_ID    Fixture org ID. Defaults to ${FIXTURE_ORG_ID}.
  SANITY_EVAL_PROJECT_ID         Project ID that must never be deleted. Defaults to ${PINNED_PROJECT_ID}.
  DRY=true                       Force dry-run mode, even with --delete.
`);
  process.exit(0);
}

const sanityToken = requireEnv('SANITY_AUTH_TOKEN');
requireEnv('ANTHROPIC_API_KEY');

const shouldDelete = values.delete && process.env.DRY !== 'true';
const protectedProjectIds = new Set(NEVER_DELETE_PROJECT_IDS);
const alwaysDeleteProjectNames = new Set(ALWAYS_DELETE_PROJECT_NAMES);

const sanityClient = createClient({
  apiHost: SANITY_API_HOST,
  apiVersion: '2021-06-07',
  projectId: PINNED_PROJECT_ID,
  token: sanityToken,
  useCdn: false,
  useProjectHostname: false,
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} environment variable is required.`);
    process.exit(1);
  }
  return value;
}

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

async function classifyProjects(projects: Project[]): Promise<z.infer<typeof cleanupDecisionSchema>['decisions']> {
  const projectIds = new Set(projects.map((project) => project.id));
  const { output } = await generateText({
    model: anthropic(MODEL),
    output: Output.object({ schema: cleanupDecisionSchema }),
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
        protectedProjectIds: [...protectedProjectIds],
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

  return output.decisions.map((decision) =>
    protectedProjectIds.has(decision.projectId) ? { ...decision, shouldDelete: false } : decision,
  );
}

function applyHardcodedPolicy(
  decisions: z.infer<typeof cleanupDecisionSchema>['decisions'],
  projectsById: Map<string, Project>,
): z.infer<typeof cleanupDecisionSchema>['decisions'] {
  return decisions.map((decision) => {
    const project = projectsById.get(decision.projectId);

    if (protectedProjectIds.has(decision.projectId)) {
      return {
        ...decision,
        shouldDelete: false,
        reason: 'Project ID is hardcoded as never delete.',
      };
    }

    if (project && alwaysDeleteProjectNames.has(project.displayName)) {
      return {
        ...decision,
        shouldDelete: true,
        reason: 'Project display name is hardcoded as always delete.',
      };
    }

    return decision;
  });
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

console.log(`Classifying projects with ${MODEL}`);
const decisions = await classifyProjects(projects);
const projectsById = new Map(projects.map((project) => [project.id, project]));
const finalDecisions = applyHardcodedPolicy(decisions, projectsById);
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
