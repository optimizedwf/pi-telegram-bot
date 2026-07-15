import assert from "node:assert/strict";
import test from "node:test";
import {
  continueGate,
  gateHandle,
  listGateSelections,
  loadChowControlConfig,
  matchesPendingGateAnswer,
  parseRecoveryReport,
  resolveGateSelection,
  type ChowCommandRunner,
  type ChowRecoveryItem,
} from "../src/chow-control.js";

const cwd = "/Users/adam26/chow-work/flow-desktop-wave1";
const project = { name: "flow", cwd };
const token = "a".repeat(64);
const item: ChowRecoveryItem = {
  job_id: `job-managed-${"b".repeat(32)}`,
  classification: "awaiting_gate",
  recommended_action: "continue_gate",
  workflow: "flow-desktop-build-v1",
  objective: "Confirm release color",
  gate: {
    run_id: "run-1",
    node_id: "approval-1",
    message: "Which color?",
    capture_response: true,
    response_required: true,
    token,
  },
};

function report(gateItem: ChowRecoveryItem = item): string {
  return JSON.stringify({
    contract: "chow.flow.managed-recovery",
    version: 1,
    cwd,
    read_only: true,
    items: [gateItem],
    counts: { awaiting_gate: 1 },
  });
}

test("configuration fails closed and validates projects", () => {
  assert.deepEqual(loadChowControlConfig({}), {
    binary: "/Users/adam26/.pi/agent/bin/chow-control",
    sshTarget: undefined,
    projects: [],
    timeoutMs: 30_000,
  });
  assert.throws(() => loadChowControlConfig({ CHOW_CONTROL_PROJECTS_JSON: '{"../bad":"/tmp"}' }));
  assert.throws(() => loadChowControlConfig({ CHOW_CONTROL_PROJECTS_JSON: '{"flow":"relative"}' }));
  assert.throws(() => loadChowControlConfig({ CHOW_CONTROL_SSH_TARGET: "host;id" }));
});

test("report parsing binds contract and cwd", () => {
  assert.equal(parseRecoveryReport(report(), cwd).items[0].gate?.token, token);
  assert.throws(() => parseRecoveryReport(report(), "/wrong"), /does not match/);
  assert.throws(() => parseRecoveryReport(report({ ...item, job_id: "bad" }), cwd), /job id/);
});

test("opaque handle is deterministic and contains no capability token", () => {
  const gate = item.gate!;
  const handle = gateHandle(project, item, gate);
  assert.match(handle, /^[a-f0-9]{16}$/);
  assert.equal(handle.includes(token), false);
  assert.equal(handle, gateHandle(project, item, gate));
});

test("selection is re-fetched and stale handles fail closed", async () => {
  const config = { binary: "/chow", projects: [project], timeoutMs: 30_000 };
  const runner: ChowCommandRunner = async () => report();
  const listed = await listGateSelections(config, runner);
  assert.equal(listed.gates.length, 1);
  assert.equal((await resolveGateSelection(listed.gates[0].handle, config, runner)).gate.token, token);
  await assert.rejects(resolveGateSelection("0".repeat(16), config, runner), /changed, expired/);
});

test("continuation distinguishes approval and response gates", async () => {
  const calls: string[][] = [];
  const runner: ChowCommandRunner = async (argv) => { calls.push(argv); return '{"owner_state":"running"}'; };
  const selection = { project, item, gate: item.gate!, handle: "1".repeat(16) };
  await continueGate(selection, runner, "amber");
  assert.deepEqual(calls[0].slice(-3), ["--gate-response", "amber", "--acknowledge-gate"]);
  await assert.rejects(continueGate(selection, runner), /non-empty answer/);

  const approval = { ...selection, gate: { ...selection.gate, capture_response: false, response_required: false } };
  await assert.rejects(continueGate(approval, runner, "nope"), /does not accept/);
  await continueGate(approval, runner);
  assert.equal(calls[1].includes("--gate-response"), false);
});

test("pending answers match exact prompts or the explicitly armed forum topic", () => {
  const pending = { promptMessageId: 42, messageThreadId: 7 };
  assert.equal(matchesPendingGateAnswer(pending, 42), true);
  assert.equal(matchesPendingGateAnswer(pending, 0, 7), true);
  assert.equal(matchesPendingGateAnswer(pending, 0, 8), false);
  assert.equal(matchesPendingGateAnswer({ promptMessageId: 42 }, 0, 7), false);
});
