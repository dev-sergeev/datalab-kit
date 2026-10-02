import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Configure only the recap model; the user's main session model is independent. */
export async function configureRecapDefault(agentDir: string): Promise<void> {
  const folder = join(agentDir, 'extensions');
  const file = join(folder, 'pi-recap.json');
  let config: unknown;
  try {
    config = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    // Leave malformed user configuration for recap's own diagnostic.
    if (error instanceof SyntaxError) return;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(folder, { recursive: true });
    try {
      await writeFile(file, `${JSON.stringify({ model: 'gigachat/Qwen3.5-397b' }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      // Another session or /recap config may have saved a choice meanwhile.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) || 'model' in config) return;
  await writeFile(file, `${JSON.stringify({ ...config, model: 'gigachat/Qwen3.5-397b' }, null, 2)}\n`);
}
