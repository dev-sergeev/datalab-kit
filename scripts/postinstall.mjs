import { fileURLToPath } from 'node:url';
import { finishInstallation } from '../dist/install.js';

await finishInstallation(fileURLToPath(new URL('../', import.meta.url)));
