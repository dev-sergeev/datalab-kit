import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export const ENHANCED_ADAPTER_VERSION = 1;
export const PERMISSION_SYSTEM_VERSION = '33.0.5';
export const ENHANCED_READINESS_KEY = 'datalab-kit.enhanced-approval.readiness';

export interface ClassifiedPath {
  path: string;
  effect: 'read' | 'write' | 'unknown';
}

/** Evidence for a single invocation, never a standing permission grant. */
export interface DangerousAnalysis {
  approval: 'ordinary' | 'enhanced';
  reasons: string[];
  commands: string[];
  paths: ClassifiedPath[];
}

export interface ClassificationContext {
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** True when an executable argument, input, or effective cwd is not static. */
  dynamic?: boolean;
  stdin?: { kind: 'text' | 'file'; value: string } | { kind: 'unknown' };
}

export interface PolicyCheck {
  surface: string;
  matchValues: string[];
}

export interface EnhancedApprovalRequest {
  command: string;
  reasons: readonly string[];
  cwd: string;
  toolName: string;
  agentName: string | null;
  policyChecks: readonly PolicyCheck[];
}

/** Versioned integration: raw veto checks must not include session grants. */
export interface EnhancedAdapter {
  version: number;
  upstreamVersion: string;
  veto(request: EnhancedApprovalRequest): string | null | Promise<string | null>;
  parentSessionId(ctx: ExtensionContext): string | undefined;
  agentName(ctx: ExtensionContext): string | null;
  isSubagent(ctx: ExtensionContext): boolean;
}

/** Loader-neutral readiness: the bootstrap must not import optional host-backed modules. */
export interface EnhancedReadiness {
  version: number;
  upstreamVersion: string;
  isReady(ctx: ExtensionContext): boolean;
}
