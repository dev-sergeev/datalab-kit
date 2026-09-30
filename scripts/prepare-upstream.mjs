import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const permission = resolve(root, 'node_modules/@gotgenes/pi-permission-system');
const subagents = resolve(root, 'node_modules/@gotgenes/pi-subagents');

async function patch(folder, path, edits, imports = []) {
  const file = resolve(folder, path);
  let text = await readFile(file, 'utf8');
  const backup = resolve(root, 'node_modules/.cache/datalab-kit', relative(root, file));
  if (text.includes('// Datalab Kit adaptation')) text = await readFile(backup, 'utf8');
  else { await mkdir(dirname(backup), { recursive: true }); await writeFile(backup, text); }
  for (const [before, after] of edits) {
    if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) {
      throw new Error(`Upstream changed: expected one patch anchor in ${path}`);
    }
    text = text.replace(before, after);
  }
  const header = imports.map(([names, module]) => {
    const path = relative(dirname(file), resolve(root, 'dist', module)).replaceAll('\\', '/');
    return `import { ${names} } from ${JSON.stringify(path.startsWith('.') ? path : './' + path)};`;
  }).join('\n');
  await writeFile(file, `// Datalab Kit adaptation\n${header}\n${text}`);
}

for (const [folder, version] of [[permission, '33.0.5'], [subagents, '21.7.5']]) {
  const pkg = JSON.parse(await readFile(resolve(folder, 'package.json'), 'utf8'));
  if (pkg.version !== version) throw new Error(`Unsupported upstream ${pkg.name}@${pkg.version}`);
}

await patch(subagents, 'src/settings.ts', [['const DEFAULT_MAX_CONCURRENT = 4;', 'const DEFAULT_MAX_CONCURRENT = 1;']]);

await patch(permission, 'src/config/policy-loader.ts', [
  ['permission: config.permission,\n    };\n\n    this.globalConfigCache', 'permission: config.permission,\n      ...(issues.length > 0 ? { invalid: true } : {}),\n    };\n\n    this.globalConfigCache'],
]);

await patch(permission, 'src/policy/permission-manager.ts', [
  ['const { mergedPermission, origins } = mergeScopesWithOrigins([', `const { mergedPermission, origins } = mergeScopesWithOrigins([
      ['builtin', [globalConfig, projectConfig, agentConfig, projectAgentConfig].some(scope => scope.invalid || scope.permission?.['*'] !== undefined) ? {} : { permission: kitPermission }],`],
  ['if (projectConfig.invalid === true) failClosedScopes.push("project");', 'if (globalConfig.invalid === true) failClosedScopes.push("global");\n    if (projectConfig.invalid === true) failClosedScopes.push("project");'],
  ['// Global is excluded — nothing more permissive is inherited when it fails.', '// Include global: Datalab Kit adds a lower default layer.'],
  ['const { composedRules } = this.resolvePermissions(intent.agentName);', 'const { composedRules, failClosedScopes } = this.resolvePermissions(intent.agentName);'],
  [`    return buildCheckResult(
      surface,
      values,
      resultExtras,
      toolName,
      intent.surface,
      fullRules,
      this.flavor,
    );`, `    const result = buildCheckResult(surface, values, resultExtras, toolName, intent.surface, fullRules, this.flavor);
    if (failClosedScopes.length === 0 && surface === 'bash' && result.origin === 'builtin' && result.state === 'ask' && isReadOnlyCommandInput(intent.input)) {
      return { ...result, state: 'allow' };
    }
    return result;`],
], [['kitPermission', 'defaults.js'], ['isReadOnlyCommandInput', 'read-policy.js']]);

await patch(permission, 'src/access-intent/bash/command-effects.ts', [
  ['  if (!isBareCoreWord(headWord)) return UNPROVEN_EFFECT;', "  if (isReadOnlyWords([headWord, ...argWords])) return CORE_READ_EFFECT;\n  if (!isBareCoreWord(headWord)) return UNPROVEN_EFFECT;"],
], [['isReadOnlyWords', 'read-policy.js']]);

await patch(permission, 'src/authority/permission-prompt-component.ts', [
  [`): Promise<PermissionPromptDecision> {
  if (view.mode === "tui") {`, `): Promise<PermissionPromptDecision> {
  const approved = await confirmPermission(view.ui, view.mode, title, payload);
  return attributeToHuman({ approved, state: approved ? 'approved' : 'denied' }, view.mode === 'tui' ? 'dialog' : 'select');
}

async function upstreamPermissionDecision(
  view: PermissionPromptView, title: string, payload: PromptPayload, options?: RequestPermissionOptions,
): Promise<PermissionPromptDecision> {
  if (view.mode === "tui") {`],
], [['confirmPermission', 'confirmation.js']]);

await patch(permission, 'src/index.ts', [
  ['(event, ctx) => gates.handleToolCall(event, ctx),', `(event, ctx) => {
        if (event.toolName === 'bash' && typeof event.input.command === 'string') {
          const normalized = normalizeLocalReadCurl(event.input.command);
          const service = getPermissionsService(ctx.sessionManager.getSessionId());
          if (normalized && service?.checkPermission('bash', event.input.command).origin === 'builtin') {
            event.input.command = normalized;
          }
        }
        return gates.handleToolCall(event, ctx);
      },`],
], [['normalizeLocalReadCurl', 'read-policy.js']]);

await patch(permission, 'src/handlers/gates/bash-command.ts', [
  ['  if (isTriviallyEmptyCommand(command)) {', `  const kitWhole = resolveOnBashSurface(command, agentName, resolver);
  if (kitWhole.origin === 'builtin' && kitWhole.state === 'ask') return kitWhole;
  if (isTriviallyEmptyCommand(command)) {`],
]);
