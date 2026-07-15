import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
const JOB_ID = /^job-managed-[a-f0-9]{16,64}$/;
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SSH_TARGET = /^(?:[a-z_][a-z0-9_-]*@)?[a-z0-9][a-z0-9.:-]*$/i;

export type ChowControlProject = { name: string; cwd: string };

export type ChowRecoveryGate = {
  run_id: string;
  node_id: string;
  message: string;
  capture_response: boolean;
  response_required: boolean;
  token: string;
};

export type ChowRecoveryItem = {
  job_id: string;
  objective?: string;
  workflow?: string;
  classification: string;
  recommended_action: string;
  gate?: ChowRecoveryGate | null;
  managed_execution?: { owner_state?: string; archon_run_id?: string };
};

export type ChowRecoveryReport = {
  contract: "chow.flow.managed-recovery";
  version: number;
  cwd: string;
  read_only: boolean;
  items: ChowRecoveryItem[];
  counts: Record<string, number>;
};

export type ChowGateSelection = {
  project: ChowControlProject;
  item: ChowRecoveryItem;
  gate: ChowRecoveryGate;
  handle: string;
};

export type ChowControlConfig = {
  binary: string;
  sshTarget?: string;
  projects: ChowControlProject[];
  timeoutMs: number;
};

export type ChowCommandRunner = (argv: string[]) => Promise<string>;

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function loadChowControlConfig(env: NodeJS.ProcessEnv = process.env): ChowControlConfig {
  const rawProjects = String(env.CHOW_CONTROL_PROJECTS_JSON || "").trim();
  const projects: ChowControlProject[] = [];
  if (rawProjects) {
    const parsed = requireObject(JSON.parse(rawProjects), "CHOW_CONTROL_PROJECTS_JSON");
    for (const [name, value] of Object.entries(parsed)) {
      if (!PROJECT_NAME.test(name)) throw new Error(`invalid Chow control project name: ${name}`);
      const cwd = String(value || "").trim();
      if (!cwd.startsWith("/") || cwd.includes("\0") || cwd.includes("\n")) {
        throw new Error(`Chow control project ${name} must use a safe absolute path`);
      }
      projects.push({ name, cwd });
    }
  }
  const sshTarget = String(env.CHOW_CONTROL_SSH_TARGET || "").trim() || undefined;
  if (sshTarget && !SSH_TARGET.test(sshTarget)) throw new Error("invalid CHOW_CONTROL_SSH_TARGET");
  const binary = String(env.CHOW_CONTROL_BIN || "/Users/adam26/.pi/agent/bin/chow-control").trim();
  if (!binary.startsWith("/") || binary.includes("\0") || binary.includes("\n")) {
    throw new Error("CHOW_CONTROL_BIN must be a safe absolute path");
  }
  const timeoutMs = Number(env.CHOW_CONTROL_TIMEOUT_MS || 30_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("CHOW_CONTROL_TIMEOUT_MS must be between 1000 and 120000");
  }
  return { binary, sshTarget, projects, timeoutMs };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function createChowCommandRunner(config: ChowControlConfig): ChowCommandRunner {
  return async (argv: string[]) => {
    const command = [config.binary, ...argv];
    const executable = config.sshTarget ? "ssh" : config.binary;
    const args = config.sshTarget
      ? ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", config.sshTarget, command.map(shellQuote).join(" ")]
      : argv;
    const { stdout } = await execFileAsync(executable, args, {
      timeout: config.timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
    });
    return stdout;
  };
}

function validateGate(raw: unknown): ChowRecoveryGate {
  const gate = requireObject(raw, "recovery gate");
  const token = String(gate.token || "");
  if (!SHA256.test(token)) throw new Error("recovery gate has an invalid token");
  const runId = String(gate.run_id || "");
  const nodeId = String(gate.node_id || "");
  if (!runId || !nodeId) throw new Error("recovery gate is missing run or node identity");
  return {
    run_id: runId,
    node_id: nodeId,
    message: String(gate.message || "").slice(0, 20_000),
    capture_response: gate.capture_response === true,
    response_required: gate.response_required === true,
    token,
  };
}

export function parseRecoveryReport(stdout: string, expectedCwd: string): ChowRecoveryReport {
  const report = requireObject(JSON.parse(stdout), "managed recovery report");
  if (report.contract !== "chow.flow.managed-recovery" || report.version !== 1) {
    throw new Error("unsupported managed recovery contract");
  }
  if (report.cwd !== expectedCwd || report.read_only !== true || !Array.isArray(report.items)) {
    throw new Error("managed recovery report does not match the requested repository");
  }
  const items = report.items.map((raw): ChowRecoveryItem => {
    const item = requireObject(raw, "recovery item");
    const jobId = String(item.job_id || "");
    if (!JOB_ID.test(jobId)) throw new Error("recovery item has an invalid job id");
    return {
      ...(item as ChowRecoveryItem),
      job_id: jobId,
      classification: String(item.classification || ""),
      recommended_action: String(item.recommended_action || ""),
      gate: item.gate == null ? null : validateGate(item.gate),
    };
  });
  return { ...(report as unknown as ChowRecoveryReport), items };
}

export async function getRecoveryReport(
  project: ChowControlProject,
  runner: ChowCommandRunner,
): Promise<ChowRecoveryReport> {
  const stdout = await runner(["--json", "archon", "managed-recovery", "--cwd", project.cwd, "--limit", "20"]);
  return parseRecoveryReport(stdout, project.cwd);
}

export function gateHandle(project: ChowControlProject, item: ChowRecoveryItem, gate: ChowRecoveryGate): string {
  return createHash("sha256")
    .update([project.name, project.cwd, item.job_id, gate.run_id, gate.node_id, gate.token].join("\0"))
    .digest("hex")
    .slice(0, 16);
}

export async function listGateSelections(
  config: ChowControlConfig,
  runner: ChowCommandRunner,
): Promise<{ gates: ChowGateSelection[]; errors: string[] }> {
  const gates: ChowGateSelection[] = [];
  const errors: string[] = [];
  for (const project of config.projects) {
    try {
      const report = await getRecoveryReport(project, runner);
      for (const item of report.items) {
        if (item.classification !== "awaiting_gate" || !item.gate) continue;
        gates.push({ project, item, gate: item.gate, handle: gateHandle(project, item, item.gate) });
      }
    } catch (error: any) {
      errors.push(`${project.name}: ${String(error?.message || error).slice(0, 180)}`);
    }
  }
  return { gates, errors };
}

export async function resolveGateSelection(
  handle: string,
  config: ChowControlConfig,
  runner: ChowCommandRunner,
): Promise<ChowGateSelection> {
  if (!/^[a-f0-9]{16}$/.test(handle)) throw new Error("invalid gate handle");
  const { gates } = await listGateSelections(config, runner);
  const matches = gates.filter((gate) => gate.handle === handle);
  if (matches.length !== 1) throw new Error("gate changed, expired, or is no longer awaiting input");
  return matches[0];
}

export async function continueGate(
  selection: ChowGateSelection,
  runner: ChowCommandRunner,
  response?: string,
): Promise<Record<string, unknown>> {
  if (selection.gate.response_required) {
    if (response == null || !response.trim()) throw new Error("this gate requires a non-empty answer");
  } else if (response != null) {
    throw new Error("this approval gate does not accept an answer");
  }
  if (response != null && (response.length > 20_000 || response.includes("\0"))) {
    throw new Error("gate answer must be at most 20000 characters without NUL bytes");
  }
  const argv = [
    "--json", "archon", "managed-continue", selection.item.job_id,
    "--cwd", selection.project.cwd,
    "--expected-gate-token", selection.gate.token,
  ];
  if (response != null) argv.push("--gate-response", response);
  argv.push("--acknowledge-gate");
  return requireObject(JSON.parse(await runner(argv)), "managed continuation result");
}
