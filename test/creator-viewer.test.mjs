import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('review resolves the evaluation prompt above configuration and repeated-run directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'datalab-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evaluation = join(root, 'eval-7-invoice-readiness');
  const outputs = join(evaluation, 'with_skill/run-1/outputs');
  await mkdir(outputs, { recursive: true });
  const prompt = 'Review the deployment readiness of invoice ingestion.';
  await writeFile(join(evaluation, 'eval_metadata.json'), JSON.stringify({ eval_id: 7, prompt }));
  await writeFile(join(outputs, 'result.txt'), 'Invoice ingestion is ready.');
  const htmlPath = join(root, 'review.html');
  const result = spawnSync(process.env.PYTHON ?? 'python3',
    [resolve('skills/skill-creator/eval-viewer/generate_review.py'), root, '--static', htmlPath],
    { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  const html = await readFile(htmlPath, 'utf8');
  assert.ok(html.includes(prompt), 'the reviewer must see the prompt associated with this nested execution');
});
