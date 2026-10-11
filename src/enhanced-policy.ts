import type { DangerousAnalysis, PolicyCheck } from './enhanced-types.js';

interface AccessPath {
  matchValues(): string[];
  boundaryValue(): string;
}
interface ProjectedPath {
  path: AccessPath;
  effect: { effect: string };
}
interface ProgramProjection {
  commandText(): string;
  commands(): readonly { text: string }[];
  pathRuleCandidates(): readonly ProjectedPath[];
  externalAccesses(): readonly ProjectedPath[];
}
interface PathInterpreter {
  forPath(path: string): AccessPath;
  isOutsideWorkingDirectory(path: string): boolean;
}

/** Keep separate operations separate: a later allow on one must not hide another's deny. */
export function collectEnhancedPolicyChecks(
  programs: readonly ProgramProjection[],
  analysis: DangerousAnalysis,
  normalizer: PathInterpreter,
): PolicyCheck[] {
  const checks: PolicyCheck[] = [];
  const seen = new Set<string>();
  const add = (surface: string, matchValues: string[]) => {
    const key = JSON.stringify([surface, matchValues]);
    if (!seen.has(key)) {
      seen.add(key);
      checks.push({ surface, matchValues });
    }
  };
  const surface = (family: string, effect: string) =>
    effect === 'read' || effect === 'write' ? `${family}_${effect}` : family;
  for (const program of programs) {
    add('bash', [program.commandText()]);
    for (const command of program.commands()) add('bash', [command.text]);
    for (const candidate of program.pathRuleCandidates()) {
      add(surface('path', candidate.effect.effect), candidate.path.matchValues());
    }
    for (const access of program.externalAccesses()) {
      add(surface('external_directory', access.effect.effect), access.path.matchValues());
    }
  }
  for (const evidence of analysis.paths) {
    const path = normalizer.forPath(evidence.path);
    add(surface('path', evidence.effect), path.matchValues());
    if (normalizer.isOutsideWorkingDirectory(path.boundaryValue())) {
      add(surface('external_directory', evidence.effect), path.matchValues());
    }
  }
  return checks;
}
