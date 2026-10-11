import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const permission = resolve(root, 'node_modules/@gotgenes/pi-permission-system');
const subagents = resolve(root, 'node_modules/@gotgenes/pi-subagents');
const planMode = resolve(root, 'node_modules/@narumitw/pi-plan-mode');
const recap = resolve(root, 'node_modules/@tifan/pi-recap');

const plannedPatches = new Map();
function patch(folder, path, edits, imports = []) {
  const file = resolve(folder, path);
  const pending = plannedPatches.get(file);
  if (pending) {
    pending.edits.push(...edits);
    pending.imports.push(...imports);
  } else {
    plannedPatches.set(file, { edits: [...edits], imports: [...imports] });
  }
}

async function applyPatch(file, { edits, imports }) {
  let text = await readFile(file, 'utf8');
  const backup = resolve(root, 'node_modules/.cache/datalab-kit', relative(root, file));
  if (text.includes('// Datalab Kit adaptation')) text = await readFile(backup, 'utf8');
  else { await mkdir(dirname(backup), { recursive: true }); await writeFile(backup, text); }
  for (const [before, after] of edits) {
    if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) {
      throw new Error(`Upstream changed: expected one patch anchor in ${relative(root, file)}`);
    }
    text = text.replace(before, after);
  }
  const header = imports.map(([names, module, typeOnly = false]) => {
    const path = relative(dirname(file), resolve(root, 'dist', module)).replaceAll('\\', '/');
    return `import ${typeOnly ? 'type ' : ''}{ ${names} } from ${JSON.stringify(path.startsWith('.') ? path : './' + path)};`;
  }).join('\n');
  await writeFile(file, `// Datalab Kit adaptation\n${header}\n${text}`);
}

for (const [folder, version] of [[permission, '33.0.5'], [subagents, '21.7.5'], [planMode, '0.58.3'], [recap, '0.4.7']]) {
  const pkg = JSON.parse(await readFile(resolve(folder, 'package.json'), 'utf8'));
  if (pkg.version !== version) throw new Error(`Unsupported upstream ${pkg.name}@${pkg.version}`);
}

// Keep the same default after /recap config -> Use default, which removes the
// saved config. Changing only the default also updates the model picker label.
await patch(recap, 'src/models.ts', [
  ['  provider: "openai-codex",\n  id: "gpt-5.6-luna",', '  provider: "gigachat",\n  id: "Qwen3.5-397b",'],
]);

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
  ['  const persistState = () => pi.appendEntry(STATE_ENTRY_TYPE, state);', `  registerPlanModeReader(
    pi.events,
    () => state.enabled && workflowMutex.isOwner(workflowOwner) ? currentSession : undefined,
    async (session, request) => {
      if (session !== currentSession || !state.enabled) return null;
      const outcome = await kitPlanAdmission({
        type: "tool_call", toolName: request.toolName,
        input: { command: request.command },
      }, { cwd: request.cwd });
      return outcome?.block ? outcome.reason ?? "Plan mode blocks this operation" : null;
    },
  );
  const persistState = () => pi.appendEntry(STATE_ENTRY_TYPE, state);`],
  ['  pi.on("tool_call", async (event, ctx) => {', '  async function kitPlanAdmission(event, ctx) {'],
  ['  });\n  pi.on("message_start", (event) => {', '  }\n  pi.on("tool_call", kitPlanAdmission);\n  pi.on("message_start", (event) => {'],
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

// The classifier consumes the same AST as the native gates, before the tree is released.
await patch(permission, 'src/access-intent/bash/program.ts', [
  ['    private readonly resolvedRuleCandidates: readonly BashPathRuleCandidate[],', '    private readonly resolvedRuleCandidates: readonly BashPathRuleCandidate[],\n    private readonly kitAnalysis: DangerousAnalysis | null = null,'],
  ['    if (!tree) return new BashProgram(command, [], [], []);', '    if (!tree) throw new Error("Enhanced approval: bash parser returned no tree");'],
  ['    try {\n      return withSalvagedRoots', `    try {
      const kitAnalysis = classifyParsedBash(tree.rootNode, {
        cwd: normalizer.resolveBase(options?.workdir ?? ""),
        env: process.env,
      }, parser);
      return withSalvagedRoots`],
  ['          ruleCandidates,\n        );', '          ruleCandidates,\n          kitAnalysis,\n        );'],
  ['  commandText(): string {', '  enhancedAnalysis(): DangerousAnalysis | null {\n    return this.kitAnalysis;\n  }\n\n  commandText(): string {'],
], [['classifyParsedBash', 'enhanced-classifier.js'], ['DangerousAnalysis', 'enhanced-types.js', true]]);

// Protected calls use all native vetoes, then exactly one human approval. Ordinary calls
// still execute the unmodified native gate loop and keep their session/YOLO behavior.
await patch(permission, 'src/handlers/gates/tool-call-gate-pipeline.ts', [
  ['import { BashProgram }', 'import type { ExtensionContext } from "@earendil-works/pi-coding-agent";\nimport { BashProgram }'],
  ['import { type GateResult, orderDenyFirst }', 'import { type GateResult, orderDenyFirst, isUnconditionalDeny }'],
  ['    runner: GateRunner,\n  ): Promise<GateOutcome>', '    runner: GateRunner,\n    ctx?: ExtensionContext,\n  ): Promise<GateOutcome>'],
  ['    const normalizer = this.inputs.getPathNormalizer();', '    const kitInvocation = shell?.command ? JSON.stringify(tcc.input) : undefined;\n    const normalizer = this.inputs.getPathNormalizer();'],
  ['export class ToolCallGatePipeline {', 'export class ToolCallGatePipeline {\n  readonly enhancedAdapterVersion = typeof BashProgram.prototype.enhancedAnalysis === "function" ? ENHANCED_ADAPTER_VERSION : 0;'],
  ['    for (const gate of orderDenyFirst(gates)) {', `    const kitAnalysis = bashProgram?.enhancedAnalysis();
    if (bashProgram && kitAnalysis?.approval === "enhanced") {
      for (const gate of gates.filter(isUnconditionalDeny)) {
        const outcome = await runner.run(gate, tcc.agentName);
        if (outcome.action === "block") return outcome;
      }
      if (!ctx) return { action: "block", reason: "Enhanced approval: no session context" };
      const programs = [bashProgram];
      const nativeCommands = new Set(bashProgram.commands().map(unit => unit.text));
      for (const text of kitAnalysis.commands) {
        if (text === bashProgram.commandText() || nativeCommands.has(text)) continue;
        nativeCommands.add(text);
        programs.push(await BashProgram.parse(text, normalizer, { workdir: shell?.workdir }));
      }
      const request = {
        command: bashProgram.commandText(),
        reasons: kitAnalysis.reasons,
        cwd: normalizer.resolveBase(shell?.workdir ?? ""),
        toolName: tcc.toolName,
        agentName: tcc.agentName ?? null,
        policyChecks: collectEnhancedPolicyChecks(programs, kitAnalysis, normalizer),
      };
      const approved = await authorizeEnhancedApproval(ctx, request);
      if (JSON.stringify(tcc.input) !== kitInvocation) {
        return { action: "block", reason: "Enhanced approval: invocation changed during confirmation" };
      }
      return approved ? { action: "allow" } : {
        action: "block", reason: "Enhanced approval denied or unavailable; policy and Plan vetoes cannot be overridden",
      };
    }

    for (const gate of orderDenyFirst(gates)) {`],
], [['collectEnhancedPolicyChecks', 'enhanced-policy.js'],
  ['authorizeEnhancedApproval', 'enhanced-runtime.js'],
  ['ENHANCED_ADAPTER_VERSION', 'enhanced-types.js']]);

await patch(permission, 'src/handlers/permission-gate-handler.ts', [
  ['return await this.pipeline.evaluate(tcc, this.runner);', 'return await this.pipeline.evaluate(tcc, this.runner, ctx);'],
]);

await patch(permission, 'src/index.ts', [
  ['import { PERMISSION_FORWARDING_TIMEOUT_MS }', 'import { PERMISSION_FORWARDING_TIMEOUT_MS, resolvePermissionForwardingTarget }'],
  ['  const resolver = new PermissionResolver(permissionManager, sessionRules);', `  const resolver = new PermissionResolver(permissionManager, sessionRules);
  const kitRawResolver = new PermissionResolver(permissionManager, { getRuleset: () => [] });`],
  ['      logger,\n    ),\n  );\n}', `      logger,
    ),
  );
  if (toolCallGatePipeline.enhancedAdapterVersion !== ENHANCED_ADAPTER_VERSION) return;
  registerEnhancedAdapter(pi, {
    version: ENHANCED_ADAPTER_VERSION,
    upstreamVersion: PERMISSION_SYSTEM_VERSION,
    veto: async (request) => {
      const kitPlanVeto = await vetoPlanInvocation(pi.events, kitSession, request);
      if (kitPlanVeto !== null) return kitPlanVeto;
      for (const check of request.policyChecks) {
        const result = kitRawResolver.resolve({
          kind: "path-values", surface: check.surface,
          values: check.matchValues, agentName: request.agentName ?? undefined,
        });
        if (result.state === "deny") {
          return result.reason ?? "Permission denied by " + check.surface + " rule";
        }
      }
      return null;
    },
    parentSessionId: (ctx) => resolvePermissionForwardingTarget({
      isSubagent: subagentDetection.isSubagent(ctx),
      currentSessionId: ctx.sessionManager.getSessionId(),
      sessionId: ctx.sessionManager.getSessionId(),
      registry: subagentRegistry,
    })?.sessionId,
    isSubagent: (ctx) => subagentDetection.isSubagent(ctx),
    agentName: (ctx) => session.resolveAgentName(ctx) ?? null,
  });
}`],
], [['registerEnhancedAdapter', 'enhanced-runtime.js'],
  ['ENHANCED_ADAPTER_VERSION, PERMISSION_SYSTEM_VERSION', 'enhanced-types.js'],
  ['vetoPlanInvocation', 'plan-mode.js']]);

for (const [file, changes] of plannedPatches) await applyPatch(file, changes);
