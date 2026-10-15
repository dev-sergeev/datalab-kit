import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('benchmarks report actual repetitions and preserve unavailable telemetry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'datalab-benchmark-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const addRun = async (configuration, number, passed) => {
    const dir = join(root, 'eval-0-readiness', configuration, `run-${number}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'grading.json'), JSON.stringify({
      summary: { passed: Number(passed), failed: Number(!passed), total: 1, pass_rate: Number(passed) },
      expectations: [{ text: 'Uses the approved readiness format.', passed, evidence: 'Observed output.' }],
    }));
  };
  const aggregate = async () => {
    const result = spawnSync(process.env.PYTHON ?? 'python3',
      [resolve('skills/skill-creator/scripts/aggregate_benchmark.py'), root],
      { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
    return JSON.parse(await readFile(join(root, 'benchmark.json'), 'utf8'));
  };
  await addRun('with_skill', 1, true);
  await addRun('without_skill', 1, false);
  let benchmark = await aggregate();
  assert.equal(benchmark.metadata.runs_per_configuration, 1);
  assert.equal(benchmark.run_summary.with_skill.tokens, null);
  assert.equal(benchmark.run_summary.with_skill.time_seconds, null);
  await addRun('with_skill', 2, false);
  benchmark = await aggregate();
  assert.equal(benchmark.metadata.runs_per_configuration, null, 'unequal repetition counts have no single scalar count');
  assert.equal(benchmark.run_summary.with_skill.pass_rate.mean, 0.5);
});
