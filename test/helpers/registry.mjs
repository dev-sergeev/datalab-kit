import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const run = promisify(execFile);
export const packInfo = stdout => {
  const result = JSON.parse(stdout);
  return Array.isArray(result) ? result[0] : Object.values(result)[0];
};

export async function registry(root) {
  const versions = new Map();
  const latest = new Map();
  let origin;
  const server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1);
      if (path.startsWith('tarballs/')) {
        const file = [...versions.values()].find(entry => entry.file === path.slice(9));
        if (!file) { response.writeHead(404).end(); return; }
        response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(await readFile(file.path));
        return;
      }
      const entries = [...versions.values()].filter(entry => entry.name === path);
      if (!entries.length) { response.writeHead(404).end(JSON.stringify({ error: 'fixture package not found' })); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        name: path, 'dist-tags': { latest: latest.get(path) },
        versions: Object.fromEntries(entries.map(entry => [entry.version, {
          ...entry.manifest,
          dist: { tarball: `${origin}/tarballs/${entry.file}`, shasum: entry.shasum },
        }])),
      }));
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    close: () => new Promise(resolve => server.close(resolve)),
    async add(manifest, path) {
      const file = `${manifest.name.replaceAll('/', '-').replace('@', '')}-${manifest.version}.tgz`;
      const entry = { manifest, name: manifest.name, version: manifest.version, file, path,
        shasum: createHash('sha1').update(await readFile(path)).digest('hex') };
      versions.set(`${manifest.name}@${manifest.version}`, entry);
      latest.set(manifest.name, manifest.version);
    },
    async addGiga(version) {
      const dir = join(root, `giga-${version}`);
      await mkdir(dir);
      const manifest = { name: '@dev-sergeev/pi-gigachat', version, type: 'module',
        exports: { './package.json': './package.json' }, pi: { extensions: ['./extension.js'] } };
      await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
      await writeFile(join(dir, 'extension.js'), 'import { getAgentDir } from "@earendil-works/pi-coding-agent"; export default function(pi) { pi.registerCommand("fixture-giga", { description: getAgentDir(), handler: async () => {} }); }');
      const { stdout } = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: dir });
      await this.add(manifest, join(root, packInfo(stdout).filename));
    },
  };
}
