# Third-party notices

Datalab Kit includes the following upstream components. Their licenses and copyright notices remain in their package directories and apply to those components and their transitive dependencies. Datalab Kit modifies permission-system, plan-mode, subagents and recap's default model during build; see scripts/prepare-upstream.mjs. The standalone GigaChat package is downloaded separately; its public default and stream exports and required helpers are also bundled in dist/gigachat-stream.js without source patches.

- @dev-sergeev/pi-gigachat@0.6.5 (independently installed, version pinned; public adapter also bundled): MIT, git+https://github.com/dev-sergeev/pi-gigachat.git.
- @earendil-works/pi-ai@0.85.1 (helpers bundled with the GigaChat adapter; host API remains external): MIT, https://github.com/earendil-works/pi.
- eventsource-parser@3.1.1 (bundled with the GigaChat adapter): MIT, https://github.com/rexxars/eventsource-parser.
- proper-lockfile@4.1.2 and undici@8.11.2 (bundled runtime dependencies): MIT; their notices remain in their package directories.
- @juicesharp/rpiv-ask-user-question@2.11.0: MIT, git+https://github.com/juicesharp/rpiv-mono.git.
- pi-powerline-footer@0.17.2: MIT, git+https://github.com/nicobailon/pi-powerline-footer.git.
- @gotgenes/pi-permission-system@33.0.5: MIT, git+https://github.com/gotgenes/pi-packages.git.
- @narumitw/pi-plan-mode@0.58.3: MIT, https://github.com/narumiruna/pi-extensions.
- @gotgenes/pi-subagents@21.7.5: MIT, git+https://github.com/gotgenes/pi-packages.git.
- @capdiem/pi-todo@0.3.2: MIT, git+https://github.com/capdiem/pi-extensions.git.
- pi-rewind@0.5.0: MIT, git+https://github.com/arpagon/pi-rewind.git.
- @tifan/pi-recap@0.4.7: MIT, git+https://github.com/tifandotme/pi-extensions.git.
- @pi-plugins/elapsed@0.1.1: MIT, git+https://github.com/k3dom/pi-plugins.git.
- pi-toggle-skills@0.1.20: MIT, git+https://github.com/monotykamary/pi-toggle-skills.git.
- @zigai/pi-mention-skill@0.10.4: MIT, git+https://github.com/zigai/pi-tweaks.git.
- Anthropic skill-creator: Apache-2.0, https://github.com/anthropics/skills/tree/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/skill-creator. Source revision: `dbd4588f9e1033efb41dad4bef2f7947c8993d44`; copyright 2026 Anthropic, PBC. License retained at `skills/skill-creator/LICENSE.txt`.

The skill-creator copy is adapted for Pi: instructions, destinations, isolated evaluation and description optimization through Pi's JSON CLI, honest missing-telemetry and repetition reporting, Pi frontmatter validation, and review metadata/server behavior. Modified files carry notices. Python resources, supporting agent instructions, schemas, viewer assets, and the complete Apache-2.0 license are included in the npm package; Claude Code is not required.

For the adapted subagents component and bundled GigaChat, pi-ai and eventsource-parser code, the upstream MIT notices are reproduced below:

MIT License

Copyright (c) 2026 tintinweb
Copyright (c) 2026 nyddle
Copyright (c) 2025 Mario Zechner
Copyright (c) 2026 Espen Hovlandsdal <espen@hovlandsdal.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
