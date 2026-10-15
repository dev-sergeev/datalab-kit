import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('creator validation accepts Pi explicit-only skills without accepting unsupported frontmatter', async t => {
  const root = await mkdtemp(join(tmpdir(), 'datalab-skill-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skill = join(root, 'deployment-review');
  await mkdir(skill);
  const file = join(skill, 'SKILL.md');
  const frontmatter = 'name: deployment-review\ndescription: Review a deployment when explicitly requested.\n';
  const validate = () => spawnSync(process.env.PYTHON ?? 'python3',
    [resolve('skills/skill-creator/scripts/quick_validate.py'), skill],
    { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  await writeFile(file, `---\n${frontmatter}disable-model-invocation: true\n---\n# Deployment review\nReview the deployment supplied by the user.\n`);
  const valid = validate();
  assert.equal(valid.status, 0, valid.stderr || valid.stdout || valid.error?.message);
  await writeFile(file, `---\n${frontmatter}unsupported-invocation-setting: true\n---\n# Deployment review\nReview the deployment supplied by the user.\n`);
  const invalid = validate();
  assert.equal(invalid.status, 1, invalid.stderr || invalid.stdout || invalid.error?.message);
});

test('optimization reports retain observed training scores when holdout is disabled', () => {
  const data = {
    holdout: 0,
    original_description: 'Release readiness instructions.',
    best_description: 'Release readiness instructions.',
    history: [{
      iteration: 1, description: 'Release readiness instructions.',
      train_passed: 1, train_total: 1,
      train_results: [{
        query: 'Prepare the release readiness message.', should_trigger: true,
        triggers: 2, runs: 3, pass: true,
      }],
      test_passed: null, test_total: null, test_results: null,
    }],
  };
  const result = spawnSync(process.env.PYTHON ?? 'python3',
    [resolve('skills/skill-creator/scripts/generate_report.py'), '-'],
    { input: JSON.stringify(data), encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /2\/3/);
});
