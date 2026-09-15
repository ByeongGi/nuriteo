export type PermissionScope = "network" | "filesystem" | "process" | "preview";
export type PermissionDecision = "allow" | "deny";
export type PermissionAuditStatus = "allowed" | "denied";
export type PermissionErrorCode = "EPERMISSION" | (string & {});

export interface PermissionRequest {
  scope: PermissionScope;
  action: string;
  resource: string;
  projectId?: string;
  reason?: string;
}

export interface PermissionAuditEntry extends PermissionRequest {
  at: number;
  status: PermissionAuditStatus;
  decision: PermissionDecision;
}

export interface PermissionRule {
  scope: PermissionScope;
  action?: string;
  resourcePrefix?: string;
  decision: PermissionDecision;
}

export interface PermissionManagerOptions {
  rules?: PermissionRule[];
  defaultDecision?: PermissionDecision;
  now?: () => number;
}

export class PermissionDeniedError extends Error {
  code: PermissionErrorCode;
  request: PermissionRequest;

  constructor(request: PermissionRequest) {
    super(`permission denied for ${request.scope}:${request.action} ${request.resource}`);
    this.name = "PermissionDeniedError";
    this.code = "EPERMISSION";
    this.request = { ...request };
  }
}

export class PermissionManager {
  readonly rules: PermissionRule[];
  readonly defaultDecision: PermissionDecision;
  readonly now: () => number;
  readonly auditLog: PermissionAuditEntry[];

  constructor(options: PermissionManagerOptions = {}) {
    this.rules = [...(options.rules || [])];
    this.defaultDecision = options.defaultDecision || "allow";
    this.now = options.now || (() => Date.now());
    this.auditLog = [];
  }

  check(request: PermissionRequest): PermissionDecision {
    const decision = this.#decision(request);
    this.auditLog.push({
      at: this.now(),
      status: decision === "allow" ? "allowed" : "denied",
      decision,
      ...request
    });
    return decision;
  }

  assertAllowed(request: PermissionRequest): void {
    if (this.check(request) === "deny") throw new PermissionDeniedError(request);
  }

  entries(scope?: PermissionScope): PermissionAuditEntry[] {
    return this.auditLog
      .filter((entry) => scope === undefined || entry.scope === scope)
      .map((entry) => ({ ...entry }));
  }

  #decision(request: PermissionRequest): PermissionDecision {
    const rule = this.rules.find((candidate) => matchesRule(candidate, request));
    return rule?.decision || this.defaultDecision;
  }
}

export function createPermissionManager(options: PermissionManagerOptions = {}): PermissionManager {
  return new PermissionManager(options);
}

function matchesRule(rule: PermissionRule, request: PermissionRequest): boolean {
  if (rule.scope !== request.scope) return false;
  if (rule.action !== undefined && rule.action !== request.action) return false;
  if (rule.resourcePrefix !== undefined && !request.resource.startsWith(rule.resourcePrefix)) return false;
  return true;
}
