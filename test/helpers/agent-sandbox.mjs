import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function agentSandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'datalab-agent-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd);
  await mkdir(agentDir);
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = '1';
  let session;
  t.after(async () => {
    try {
      if (session) {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
        session.dispose();
      }
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
  return { cwd, agentDir, trackSession: value => { session = value; } };
}
