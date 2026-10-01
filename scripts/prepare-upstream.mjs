import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const permission = resolve(root, 'node_modules/@gotgenes/pi-permission-system');
const subagents = resolve(root, 'node_modules/@gotgenes/pi-subagents');
const planMode = resolve(root, 'node_modules/@narumitw/pi-plan-mode');

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

for (const [folder, version] of [[permission, '33.0.5'], [subagents, '21.7.5'], [planMode, '0.58.3']]) {
  const pkg = JSON.parse(await readFile(resolve(folder, 'package.json'), 'utf8'));
  if (pkg.version !== version) throw new Error(`Unsupported upstream ${pkg.name}@${pkg.version}`);
}

// Restore former UI adaptations when rebuilding an existing 0.1.1 checkout.
// Clean obsolete outputs too: tsc does not remove files for deleted sources.
for (const path of ['src/config/config-store.ts', 'src/authority/permission-prompt-component.ts']) {
  const file = resolve(permission, path);
  if ((await readFile(file, 'utf8')).includes('// Datalab Kit adaptation')) {
    const backup = resolve(root, 'node_modules/.cache/datalab-kit', relative(root, file));
    await writeFile(file, await readFile(backup, 'utf8'));
  }
}
for (const name of ['confirmation', 'yolo']) {
  for (const extension of ['js', 'd.ts']) await rm(resolve(root, 'dist', `${name}.${extension}`), { force: true });
}

await patch(planMode, 'dist/index.ts', [
  ['  const persistState = () => pi.appendEntry(STATE_ENTRY_TYPE, state);', `  registerPlanModeReader(pi.events, () => state.enabled && workflowMutex.isOwner(workflowOwner) ? currentSession : undefined);
  const persistState = () => pi.appendEntry(STATE_ENTRY_TYPE, state);`],
], [['registerPlanModeReader', 'plan-mode.js']]);

await patch(subagents, 'src/settings.ts', [['const DEFAULT_MAX_CONCURRENT = 4;', 'const DEFAULT_MAX_CONCURRENT = 1;']]);

await patch(subagents, 'src/lifecycle/subagent-manager.ts', [
  ['status: isBackground ? "queued" : "running",', 'status: "queued",'],
  [`    if (isBackground && !options.bypassQueue) {
      // Schedule on the limiter — scheduleVia captures the limiter promise
      // eagerly, so a queued agent is awaitable from spawn; guardedRun guards
      // against abort-while-queued when the slot frees.
      record.scheduleVia((thunk) => this.limiter.schedule(thunk));
      return id;
    }

    record.start();`, `    // Share the configured limit across background, foreground and RPC spawns.
    record.scheduleVia((thunk) => this.limiter.schedule(thunk));`],
  ['await agent.resume(prompt, options.signal);', 'await agent.resume(prompt, options.signal, thunk => this.limiter.schedule(thunk));'],
  ['Foreground agents bypass the limiter (they block the parent anyway).', 'Foreground and background agents share the limiter.'],
  ['Foreground agents bypass the concurrency queue.', 'Foreground agents share the concurrency queue.'],
  ['must\n   * not be queued and must not be announced', 'must\n   * not be announced'],
]);

await patch(subagents, 'src/lifecycle/subagent.ts', [
  ['resume(prompt: string, signal?: AbortSignal): Promise<void> {', 'resume(prompt: string, signal?: AbortSignal, schedule: (task: () => Promise<void>) => Promise<void> = task => task()): Promise<void> {'],
  ['this._promise = this.runResume(subagentSession, prompt, signal);', `this._abortController = new AbortController();
    this.resetForResume(Date.now());
    this.listeners.wireSignal(signal, () => this.abort());
    this._promise = schedule(() => this.isActive() ? this.runResume(subagentSession, prompt, signal) : Promise.resolve());`],
]);

await patch(permission, 'src/config/policy-loader.ts', [
  ['permission: config.permission,\n    };\n\n    this.globalConfigCache', 'permission: config.permission,\n      ...(issues.length > 0 ? { invalid: true } : {}),\n    };\n\n    this.globalConfigCache'],
]);

await patch(permission, 'src/policy/permission-manager.ts', [
  ['export interface PermissionManagerOptions extends PolicyLoaderOptions {', 'export interface PermissionManagerOptions extends PolicyLoaderOptions {\n  kitIsPlanMode?: () => boolean;'],
  ['private readonly isYoloEnabled: () => boolean;', 'private readonly isYoloEnabled: () => boolean;\n  private readonly kitIsPlanMode: () => boolean;'],
  ['this.isYoloEnabled = options.isYoloEnabled ?? YOLO_DISABLED;', 'this.isYoloEnabled = options.isYoloEnabled ?? YOLO_DISABLED;\n    this.kitIsPlanMode = options.kitIsPlanMode ?? (() => false);'],
  ['const cacheKey = agentName ?? "__global__";', 'const planMode = this.kitIsPlanMode();\n    const cacheKey = JSON.stringify([agentName, planMode]);'],
  ['  getResolvedPolicyPaths(): ResolvedPolicyPaths {', `  kitCanDelegateToPlanMode(agentName?: string): boolean {
    return this.kitIsPlanMode() && this.resolvePermissions(agentName).failClosedScopes.length === 0;
  }

  getResolvedPolicyPaths(): ResolvedPolicyPaths {`],
  ['const { mergedPermission, origins } = mergeScopesWithOrigins([', `const { mergedPermission, origins } = mergeScopesWithOrigins([
      ['builtin', [globalConfig, projectConfig, agentConfig, projectAgentConfig].some(scope => scope.invalid || scope.permission?.['*'] !== undefined) ? {} : { permission: planMode ? { '*': 'allow' } : kitPermission }],`],
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
  ['  if (!isBareCoreWord(headWord)) return UNPROVEN_EFFECT;', "  if (isKnownReadCommand(headWord)) return isReadOnlyWords([headWord, ...argWords]) ? CORE_READ_EFFECT : UNPROVEN_EFFECT;\n  if (!isBareCoreWord(headWord)) return UNPROVEN_EFFECT;"],
], [['isReadOnlyWords, isKnownReadCommand', 'read-policy.js']]);

await patch(permission, 'src/access-intent/bash/bash-path-resolver.ts', [
  [`        tagTokens(collectCommandTokens(node), base, out);
        return this.foldCd(node, base);`, `        const tokens = collectCommandTokens(node);
        const present = new Set(tokens.map(token => token.token));
        const globEffect = isReadOnlyCommand(node.text) ? { effect: 'read' as const, source: 'core' as const } : UNPROVEN_EFFECT;
        tagTokens([
          ...tokens,
          ...shellGlobTokens(node.text).filter(token => !present.has(token)).map(token => ({ token, effect: globEffect })),
        ], base, out);
        return this.foldCd(node, base);`],
  [`    return {
      externalAccesses: this.withWorkdirExternal(
        this.projectExternalPaths(candidates),
      ),
      ruleCandidates: this.projectRuleCandidates(candidates),
    };`, `    const globTokens = new Set(shellGlobTokens(rootNode.text));
    const expandedCandidates = candidates.flatMap(candidate => {
      if (candidate.base.kind !== 'known' || !globTokens.has(candidate.token)) return [candidate];
      const cwd = this.normalizer.resolveBase(candidate.base.offset);
      return [candidate, ...expandShellGlob(candidate.token, cwd).map(token => ({ ...candidate, token }))];
    });
    return {
      externalAccesses: this.withWorkdirExternal(this.projectExternalPaths(expandedCandidates)),
      ruleCandidates: this.projectRuleCandidates(expandedCandidates),
    };`],
], [['shellGlobTokens, expandShellGlob, isReadOnlyCommand', 'read-policy.js']]);

await patch(permission, 'src/index.ts', [
  ['import type { ExtensionAPI }', 'import type { ExtensionAPI, ExtensionContext }'],
  ['  const permissionManager = new PermissionManager({', '  let kitSession: ExtensionContext["sessionManager"] | undefined;\n  const permissionManager = new PermissionManager({\n    kitIsPlanMode: () => isPlanModeActive(pi.events, kitSession),'],
  ['  pi.on("session_start", (event, ctx) =>\n    lifecycle.handleSessionStart(event, ctx),\n  );', '  pi.on("session_start", async (event, ctx) => {\n    kitSession = ctx.sessionManager;\n    await lifecycle.handleSessionStart(event, ctx);\n  });'],
  ['    reporter,\n    isYoloEnabled,\n  );', '    reporter,\n    isYoloEnabled,\n    agentName => permissionManager.kitCanDelegateToPlanMode(agentName),\n  );'],
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
], [['normalizeLocalReadCurl', 'read-policy.js'], ['isPlanModeActive', 'plan-mode.js']]);

// Synthetic bash asks also carry builtin provenance. Delegate those only when
// Plan mode is active and every user policy loaded successfully.
await patch(permission, 'src/handlers/gates/runner.ts', [
  ['    private readonly isYoloEnabled: () => boolean,', '    private readonly isYoloEnabled: () => boolean,\n    private readonly kitCanDelegate: (agentName?: string) => boolean = () => false,'],
  ['    const check =\n      preResolvedCheckOf(descriptor)', '    let check =\n      preResolvedCheckOf(descriptor)'],
  ['    // The fields every review-log write for this gate shares,', `    if (check.origin === 'builtin' && check.state === 'ask' && this.kitCanDelegate(agentName ?? undefined)) {
      check = { ...check, state: 'allow' };
    }

    // The fields every review-log write for this gate shares,`],
]);

await patch(permission, 'src/handlers/gates/bash-command.ts', [
  ['  if (isTriviallyEmptyCommand(command)) {', `  const kitWhole = resolveOnBashSurface(command, agentName, resolver);
  if (kitWhole.state === 'deny') return kitWhole;
  if (isTriviallyEmptyCommand(command)) {`],
  [`  const results = commands.map((cmd) =>
    resolveCommandUnit(cmd, command, agentName, resolver),
  );`, `  const parsedCommands = inspectionCommands(command);
  const results = [
    ...commands.map(cmd => resolveCommandUnit(cmd, command, agentName, resolver)),
    ...(parsedCommands?.map(text => resolveOnBashSurface(text, agentName, resolver)) ?? []),
  ];`],
  [`  return (
    pickMostRestrictive(results) ??
    resolveOnBashSurface(command, agentName, resolver)
  );`, `  const worst = pickMostRestrictive(kitWhole.origin === 'builtin' && parsedCommands !== undefined ? results : [kitWhole, ...results]);
  return worst ?? kitWhole;`],
], [['inspectionCommands', 'read-policy.js']]);
