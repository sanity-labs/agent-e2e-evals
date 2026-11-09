/**
 * Staging projects visible to the Sanity token, listed before and after a batch.
 *
 * Live tasks (the getting-started scaffold) create real staging projects, and
 * the shared robot token can't delete them. The batch never deletes anything:
 * it saves both raw lists and names the projects first seen during the batch
 * for manual reconciliation. With a shared token and other
 * work going on, "first seen during the batch" is not proof the batch made them.
 */
import { sanityEvalEnv } from '../experiments/lib/base-setup.ts';

export interface StagingProject {
  id: string;
  displayName?: string;
  organizationId?: string | null;
  createdAt?: string;
}

/** Shared canary for the Getting Started walkthrough: never a cleanup candidate. */
const PROTECTED_PROJECTS = ['bos8r3z6'];

export async function listStagingProjects(token: string): Promise<StagingProject[]> {
  const res = await fetch(`${sanityEvalEnv.SANITY_API_HOST}/v2021-06-07/projects`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Sanity staging project list failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  // A list we can't diff is no baseline: stop rather than run live work unrecorded.
  if (!Array.isArray(body) || !body.every((p) => typeof p?.id === 'string' && p.id !== '')) {
    throw new Error('Sanity staging project list was not an array of projects with string IDs');
  }
  return body.map(({ id, displayName, organizationId, createdAt }) => ({ id, displayName, organizationId, createdAt }));
}

/** Projects in `after` but not `before`, minus protected ones. Listed for manual reconciliation; never deleted here. */
export function newlyObserved(before: StagingProject[], after: StagingProject[]): StagingProject[] {
  const seen = new Set(before.map((p) => p.id));
  return after.filter((p) => !seen.has(p.id) && !PROTECTED_PROJECTS.includes(p.id));
}
