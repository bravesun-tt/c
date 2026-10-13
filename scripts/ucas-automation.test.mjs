import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "scripts/ucas-automation.mjs");
const temp = mkdtempSync(join(tmpdir(), "ucas-retry-test-"));
after(() => rmSync(temp, { recursive: true, force: true }));
const mockPath = join(temp, "mock.mjs");

// Run the real CLI with mocked upstream responses and instant virtual-time delays.
writeFileSync(mockPath, `
import { readFileSync, writeFileSync } from 'node:fs';
import timers from 'node:timers/promises';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
const fixture = JSON.parse(readFileSync('fixture.json', 'utf8'));
const OriginalDate = Date;
let now = OriginalDate.parse(fixture.now);
const calls = [];
const delays = [];
const counters = {};
let jitterIndex = 0;
const save = () => writeFileSync('trace.json', JSON.stringify({ calls, delays, now }));
globalThis.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
};
timers.setTimeout = async (ms) => { delays.push(ms); now += ms; save(); };
crypto.randomInt = (min, max) => {
  if (min !== 0 || max !== 11) throw new Error('Expected jitter range 0..10 seconds inclusive');
  const values = fixture.jitterSeconds || [0];
  return values[jitterIndex++ % values.length];
};
syncBuiltinESMExports();
globalThis.fetch = async (url) => {
  const parsed = new URL(url);
  const endpoint = parsed.pathname.split('/').at(-1);
  const id = parsed.searchParams.get('courseSchedId') || '';
  const key = endpoint + id;
  const count = counters[key] = (counters[key] || 0) + 1;
  calls.push({ endpoint, id, now });
  now += fixture.advance?.[endpoint] || 0;
  save();
  let data;
  if (endpoint === 'login.action') {
    if (count <= (fixture.loginFailures || 0)) throw new Error('temporary login failure');
    data = { STATUS: '0', result: { id: 'mock-user', sessionId: 'session-' + count } };
  } else if (endpoint === 'get_stu_course_sched.action') {
    if (fixture.queryFailure) throw new Error('temporary schedule failure');
    data = Object.hasOwn(fixture, 'scheduleResponse') ? fixture.scheduleResponse : { STATUS: '0', result: fixture.courses };
  } else if (endpoint === 'get_timestamp.do') {
    if (count <= (fixture.timestampFailures || 0)) throw new Error('temporary timestamp failure');
    data = { STATUS: '0', timestamp: now };
  } else if (endpoint === 'stu_scan_sign.action') {
    const outcomes = fixture.outcomes?.[id] || ['success'];
    const outcome = outcomes[Math.min(count - 1, outcomes.length - 1)];
    if (outcome === 'network') throw new Error('temporary sign network failure');
    if (outcome === 'timeout') { const error = new Error('request timeout'); error.name = 'AbortError'; throw error; }
    data = outcome === 'success'
      ? { STATUS: '0', result: { stuSignStatus: '1', stuSignId: 'signed-' + id } }
      : { STATUS: '1', ERRMSG: 'not ready', result: { stuSignStatus: '0' } };
  } else throw new Error('Unexpected endpoint: ' + url);
  return { ok: true, status: 200, text: async () => JSON.stringify(data) };
};
save();
`);

function course(id = "1000001", time = "08:30", signStatus = "0") {
	return { id, courseName: `Course ${id}`, classBeginTime: `2026-10-13 ${time}:00`, signStatus };
}

function setup(fixture = {}, attempts = {}, date = "20261013") {
	const cwd = mkdtempSync(join(temp, "case-"));
	const input = { now: "2026-10-13T08:05:00+08:00", courses: [course()], ...fixture };
	writeFileSync(join(cwd, "fixture.json"), JSON.stringify(input));
	mkdirSync(join(cwd, ".github/state"), { recursive: true });
	writeFileSync(join(cwd, ".github/state/current.json"), JSON.stringify({ date, courses: input.courses, attempts }));
	return cwd;
}

function run(cwd, command = "sign-due", expectSuccess = true) {
	const result = spawnSync(process.execPath, ["--import", mockPath, script, command], {
		cwd,
		encoding: "utf8",
		timeout: 10000,
		env: { PATH: process.env.PATH, UCAS_USERNAME: "mock", UCAS_PASSWORD: "mock", UCAS_TIMEZONE: "Asia/Shanghai" },
	});
	assert.ifError(result.error);
	if (expectSuccess) assert.equal(result.status, 0, result.stderr);
	else assert.notEqual(result.status, 0);
	const state = JSON.parse(readFileSync(join(cwd, ".github/state/current.json"), "utf8"));
	const trace = JSON.parse(readFileSync(join(cwd, "trace.json"), "utf8"));
	const mailPath = join(cwd, ".github/mail/sign-results.txt");
	const scheduleMailPath = join(cwd, ".github/mail/schedule.txt");
	return { state, ...trace, stderr: result.stderr, mail: existsSync(mailPath) ? readFileSync(mailPath, "utf8") : null, scheduleMail: existsSync(scheduleMailPath) ? readFileSync(scheduleMailPath, "utf8") : null };
}

const signCalls = result => result.calls.filter(call => call.endpoint === "stu_scan_sign.action");

test("all 13 cron times are 25 minutes before class and open the signing window", () => {
	const starts = ["08:30", "09:20", "10:25", "11:15", "13:30", "14:20", "15:25", "16:15", "17:05", "18:30", "19:20", "20:15", "21:05"];
	const workflow = readFileSync(join(root, ".github/workflows/ucas-sign-due.yml"), "utf8");
	const crons = [...workflow.matchAll(/cron: "(\d+) (\d+) \* \* \*"/g)];
	assert.equal(crons.length, 13);
	assert.match(workflow, /timeout-minutes: 45/);
	const fetchIndex = workflow.indexOf("ucas-automation.mjs fetch-schedule");
	assert.ok(fetchIndex >= 0 && fetchIndex < workflow.indexOf("ucas-automation.mjs sign-due"));
	const manualWorkflow = readFileSync(join(root, ".github/workflows/ucas-fetch-schedule.yml"), "utf8");
	assert.doesNotMatch(manualWorkflow, /^  schedule:/m);
	for (const [i, time] of starts.entries()) {
		const now = new Date(Date.parse(`2026-10-13T${time}:00+08:00`) - 25 * 60000);
		assert.equal(Number(crons[i][1]), now.getUTCMinutes());
		assert.equal(Number(crons[i][2]), now.getUTCHours());
		const result = run(setup({ now: now.toISOString(), courses: [course("1000001", time)] }));
		assert.equal(result.state.attempts["1000001"].status, "success");
		assert.equal(signCalls(result).length, 1);
		assert.equal(result.delays.length, 0);
	}
});

test("login, timestamp, network, timeout and rejected sign-ins retry until success", () => {
	const result = run(setup({ loginFailures: 1, timestampFailures: 1, outcomes: { "1000001": ["network", "timeout", "failure", "success"] } }));
	assert.equal(result.state.attempts["1000001"].status, "success");
	assert.equal(result.state.attempts["1000001"].attemptCount, 6);
	assert.deepEqual(result.delays, Array(5).fill(10000));
	assert.equal(result.calls.filter(call => call.endpoint === "login.action").length, 6);
	assert.equal(result.calls.filter(call => call.endpoint === "get_timestamp.do").length, 5);
	assert.equal(signCalls(result).length, 4);
	assert.match(result.mail, /成功：Course 1000001/);
	assert.match(result.mail, /累计尝试次数：6/);
});

test("each retry adds a fresh random 0..10 seconds to the 10-second base", () => {
	const result = run(setup({ jitterSeconds: [0, 5, 10], outcomes: { "1000001": ["failure", "failure", "failure", "success"] } }));
	assert.deepEqual(result.delays, [10000, 15000, 20000]);
	assert.equal(result.state.attempts["1000001"].status, "success");
	assert.equal(signCalls(result).length, 4);
});

test("random retry delay is capped at the deadline without another sign-in", () => {
	const result = run(setup({ now: "2026-10-13T08:39:55+08:00", jitterSeconds: [10], outcomes: { "1000001": ["failure"] } }));
	assert.deepEqual(result.delays, [5001]);
	assert.equal(signCalls(result).length, 1);
	assert.equal(result.state.attempts["1000001"].status, "expired");
});

test("successful courses stop while other courses continue retrying", () => {
	const result = run(setup({ courses: [course(), course("1000002")], outcomes: { "1000002": ["failure", "failure", "success"] } }));
	assert.equal(signCalls(result).filter(call => call.id === "1000001").length, 1);
	assert.equal(signCalls(result).filter(call => call.id === "1000002").length, 3);
	assert.equal(result.state.attempts["1000002"].status, "success");
	assert.match(result.mail, /成功：Course 1000001/);
	assert.match(result.mail, /成功：Course 1000002/);
});

test("continuous failure stops at the window deadline with a final failure report", () => {
	const result = run(setup({ outcomes: { "1000001": ["failure"] } }));
	assert.equal(result.state.attempts["1000001"].status, "expired");
	assert.equal(signCalls(result).length, 211);
	assert.equal(result.state.attempts["1000001"].attemptCount, 211);
	assert.ok(signCalls(result).every(call => call.now <= Date.parse("2026-10-13T08:40:00+08:00")));
	assert.match(result.mail, /失败：Course 1000001/);
	assert.match(result.mail, /窗口已结束.*not ready/);
	assert.match(result.mail, /累计尝试次数：211/);
});

test("schedule refresh preserves failed attempts for retry and successes for skipping", () => {
	const cwd = setup({ courses: [course(), course("1000002")] }, {
		"1000001": { status: "failed", attemptCount: 4 },
		"1000002": { status: "success", attemptCount: 2 },
	});
	run(cwd, "fetch-schedule");
	const result = run(cwd);
	assert.equal(result.state.attempts["1000001"].attemptCount, 5);
	assert.equal(result.state.attempts["1000001"].status, "success");
	assert.equal(signCalls(result).length, 1);
	assert.equal(result.state.attempts["1000002"].attemptCount, 2);
	const repeated = run(cwd);
	assert.equal(repeated.calls.length, 0);
	assert.equal(repeated.mail, null);
});

test("legacy failure records without a count remain retryable", () => {
	const result = run(setup({}, { "1000001": { status: "failed" } }));
	assert.equal(result.state.attempts["1000001"].status, "success");
	assert.equal(result.state.attempts["1000001"].attemptCount, 1);
});

test("courses already signed in upstream are skipped", () => {
	const result = run(setup({ courses: [course("1000001", "08:30", "1")] }, { "1000001": { status: "failed", attemptCount: 2 } }));
	assert.equal(result.calls.length, 0);
	assert.equal(result.state.attempts["1000001"].status, "success");
	assert.equal(result.mail, null);
});

test("no courses, stale dates and times outside the window make no requests", () => {
	for (const cwd of [
		setup({ courses: [] }),
		setup({}, {}, "20261012"),
		setup({ now: "2026-10-13T08:04:59+08:00" }),
		setup({ now: "2026-10-13T08:40:01+08:00" }),
	]) {
		const result = run(cwd);
		assert.equal(result.calls.length, 0);
		assert.equal(result.mail, null);
	}
});

test("a slow login or timestamp response cannot submit a sign-in past the deadline", () => {
	for (const endpoint of ["login.action", "get_timestamp.do"]) {
		const result = run(setup({ now: "2026-10-13T08:39:59+08:00", advance: { [endpoint]: 2000 } }));
		assert.equal(signCalls(result).length, 0);
		assert.equal(result.state.attempts["1000001"].status, "expired");
		assert.match(result.mail, /窗口已结束/);
	}
});

test("failed schedule refresh exits nonzero and leaves saved attempts intact", () => {
	const result = run(setup({ queryFailure: true }, { "1000001": { status: "success", attemptCount: 2 } }), "fetch-schedule", false);
	assert.equal(result.state.attempts["1000001"].status, "success");
	assert.equal(signCalls(result).length, 0);
});


test("empty schedule responses generate a no-courses email and skip signing", () => {
	const responses = [
		{ STATUS: "0", result: [] },
		{ STATUS: 0, result: [] },
		{ STATUS: "0", result: null },
		{ STATUS: "0", message: "查询成功", result: [] },
		{ STATUS: "1", result: [] },
		{ STATUS: "2", result: [] },
		{ STATUS: "2", result: null },
		{ STATUS: 2 },
		{ STATUS: "1", result: null },
		{ STATUS: "1", result: "" },
		{ STATUS: "1" },
		{ STATUS: "1", ERRMSG: "当天没有课程" },
		{ STATUS: "1", msg: "暂无课表。", result: [] },
		{ STATUS: "1", message: "未查询到相关课程", result: null },
	];
	for (const scheduleResponse of responses) {
		const cwd = setup({ scheduleResponse });
		const result = run(cwd, "fetch-schedule");
		assert.deepEqual(result.state.courses, [], JSON.stringify(scheduleResponse));
		assert.match(result.scheduleMail, /今天没有查询到课程/);
		assert.match(result.scheduleMail, /2026-10-13/);
		const signing = run(cwd);
		assert.equal(signing.calls.length, 0);
		assert.equal(signing.mail, null);
	}
});

test("normal schedule responses still include courses in the email", () => {
	for (const STATUS of ["0", 0]) {
		const result = run(setup({ scheduleResponse: { STATUS, result: [course()] } }), "fetch-schedule");
		assert.equal(result.state.courses.length, 1);
		assert.match(result.scheduleMail, /Course 1000001/);
		assert.doesNotMatch(result.scheduleMail, /今天没有查询到课程/);
	}
});

test("real upstream errors and malformed responses do not become no-courses emails", () => {
	const responses = [
		{ STATUS: "1", ERRMSG: "登录已过期", result: [] },
		{ STATUS: "1", ERRCODE: "100", result: [] },
		{ STATUS: "1", message: "服务器异常", result: null },
		{ STATUS: "1", message: "课表查询失败，或当天没有课程", result: [] },
		{ STATUS: "3", result: [] },
		{ STATUS: "2", ERRMSG: "登录已过期" },
		{ STATUS: "2", ERRCODE: "100" },
		{ STATUS: "2", result: [course()] },
		{ STATUS: "0", result: { unexpected: true } },
		{ STATUS: "0", ERRCODE: "100", result: [] },
		{ STATUS: "1", result: [course()] },
		{},
		null,
	];
	for (const scheduleResponse of responses) {
		const result = run(setup({ scheduleResponse }), "fetch-schedule", false);
		assert.match(result.stderr, /课表查询失败或返回格式异常.*STATUS=/);
		assert.equal(result.state.courses.length, 1);
		assert.equal(result.scheduleMail, null);
	}
});


test("observed UCAS no-course payload STATUS=2 without result generates the schedule email", () => {
	// Exact non-sensitive response observed after a successful real login on 2026-10-13.
	const cwd = setup({ scheduleResponse: { STATUS: "2" } });
	const result = run(cwd, "fetch-schedule");
	assert.deepEqual(result.state.courses, []);
	assert.match(result.scheduleMail, /今天没有查询到课程/);
	assert.equal(result.stderr, "");
	const signing = run(cwd);
	assert.equal(signing.calls.length, 0);
	assert.equal(signing.mail, null);
});
