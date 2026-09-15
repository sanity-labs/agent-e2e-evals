import config from './claude-sonnet-4.6-skills.js';

const branch = process.env.SANITY_SKILLS_BRANCH || 'main';
const hashes: Record<string, string> = {
  main: '39c6413b567b24b567693942ed2a53f65573e7f14c670139449e4b1b26ffff9f',
  'chore/standardize-skill-references': '4292ad7cf37b1be0247c1d327828da2a7e0ffe25c718052071a4c0cf757e9513',
};
const expected = hashes[branch];
if (!expected) throw new Error(`Unrecognized smoke-test branch: ${branch}`);

export default {
  ...config,
  runs: 1,
  timeout: 300,
  scripts: [],
  evals: 'skills-source-smoketest',
  env: { ...config.env, EXPECTED_SKILL_SHA: expected },
  agentOptions: { effort: 'low' },
};
