#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomInt } from "node:crypto";

const ROOT = resolve(process.cwd());
const STATE_FILE = resolve(ROOT, ".github/state/current.json");
const MAIL_DIR = resolve(ROOT, ".github/mail");
const SCHEDULE_MAIL_FILE = resolve(MAIL_DIR, "schedule.txt");
const SIGN_MAIL_FILE = resolve(MAIL_DIR, "sign-results.txt");

const TIMEZONE = process.env.UCAS_TIMEZONE || "Asia/Shanghai";
const SIGN_BEFORE_MINUTES = positiveInt(process.env.SIGN_BEFORE_MINUTES, 25);
const SIGN_RETRY_INTERVAL_MS = positiveInt(process.env.SIGN_RETRY_INTERVAL_MS, 10000);
const SIGN_GRACE_MINUTES = positiveInt(process.env.SIGN_GRACE_MINUTES, 10);
const REQUEST_TIMEOUT_MS = positiveInt(process.env.UCAS_REQUEST_TIMEOUT_MS, 15000);
const SIGN_TIMESTAMP_BUFFER_MS = positiveInt(process.env.SIGN_TIMESTAMP_BUFFER_MS, 5000);

const LOGIN_URL = "https://iclass.ucas.edu.cn:8181/app/user/login.action";
const SCHEDULE_URL = "https://iclass.ucas.edu.cn:8181/app/course/get_stu_course_sched.action";
const TIMESTAMP_URL = "https://iclass.ucas.edu.cn:8181/app/common/get_timestamp.do";
const SIGN_URL = "https://iclass.ucas.edu.cn:8181/app/course/stu_scan_sign.action";
const LOGIN_UA = "student_5.0.1.2_android_12_20__110000";
const API_UA = "student_5.0.1.2_android_12_20_100000000000000_110000";

function positiveInt(value, fallback) {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function credentials() {
	let username = process.env.UCAS_USERNAME?.trim() || "";
	let password = process.env.UCAS_PASSWORD || "";
	const credentialsFile = resolve(ROOT, process.env.UCAS_CREDENTIALS_FILE || "config/credentials.json");

	if ((!username || !password) && existsSync(credentialsFile)) {
		const file = JSON.parse(requireFile(credentialsFile));
		username = username || String(file.username ?? file.phone ?? "").trim();
		password = password || String(file.password ?? "");
	}

	if (!username || !password) {
		throw new Error("未找到 UCAS 账号配置：请设置 UCAS_USERNAME/UCAS_PASSWORD，或填写 config/credentials.json");
	}
	return { username, password };
}

function requireFile(path) {
	// This synchronous read is only used for the tiny credentials file, before any network request.
	return readFileSync(path, "utf8");
}

function currentDateInTimezone(date = new Date()) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: TIMEZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
	return `${values.year}${values.month}${values.day}`;
}

function displayDate(yyyymmdd) {
	return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function parseUcasTime(value) {
	const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
	if (!match) return null;
	const [, year, month, day, hour, minute, second = "00"] = match;
	const utcValue = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
	return Number.isNaN(utcValue) ? null : utcValue - 8 * 60 * 60 * 1000;
}

function normalizeCourse(item) {
	return {
		id: String(item?.id ?? "").trim(),
		uuid: String(item?.uuid ?? "").trim(),
		courseName: String(item?.courseName ?? "").trim(),
		teacherName: String(item?.teacherName ?? "").trim(),
		weekDay: String(item?.weekDay ?? "").trim(),
		classBeginTime: String(item?.classBeginTime ?? "").trim(),
		classEndTime: String(item?.classEndTime ?? "").trim(),
		signStatus: String(item?.signStatus ?? "").trim(),
	};
}

async function fetchJson(url, options = {}) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
		const text = await response.text();
		let data;
		try {
			data = JSON.parse(text);
		} catch {
			throw new Error(`上游返回非 JSON（HTTP ${response.status}）`);
		}
		if (!response.ok) throw new Error(`上游请求失败（HTTP ${response.status}）：${JSON.stringify(data)}`);
		return data;
	} catch (error) {
		if (error?.name === "AbortError") throw new Error(`上游请求超时（>${REQUEST_TIMEOUT_MS}ms）`);
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

function loginBody(username, password) {
	return new URLSearchParams({
		phone: username,
		password,
		verificationType: "1",
		verificationUrl: "http://iclass.ucas.edu.cn:88/ve/webservices/mobileCheck.shtml?method=mobileLogin&username=${0}&password=${1}&lx=${2}",
		userLevel: "1",
	}).toString();
}

async function login() {
	const { username, password } = credentials();
	const data = await fetchJson(LOGIN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": LOGIN_UA },
		body: loginBody(username, password),
	});
	const sessionId = data?.result?.sessionId;
	const userId = data?.result?.id;
	if (data?.STATUS !== "0" || !sessionId || !userId) throw new Error("UCAS 登录失败，请检查账号和密码");
	return { sessionId, userId };
}

async function fetchSchedule(date) {
	const { sessionId, userId } = await login();
	const data = await fetchJson(`${SCHEDULE_URL}?id=${encodeURIComponent(userId)}&dateStr=${encodeURIComponent(date)}`, {
		method: "GET",
		headers: { sessionId, "User-Agent": API_UA },
	});
	if (data?.STATUS !== "0") throw new Error("课表查询失败，或当天没有课程");
	return (Array.isArray(data.result) ? data.result : []).map(normalizeCourse);
}

async function serverTimestamp() {
	const data = await fetchJson(`${TIMESTAMP_URL}?id=${Math.floor(Math.random() * 1000000)}`, {
		method: "POST",
		headers: { "User-Agent": API_UA, Connection: "Keep-Alive" },
	});
	if (data?.STATUS !== "0" || typeof data.timestamp !== "number") throw new Error("UCAS 时间戳接口返回异常");
	return data.timestamp;
}

async function signCourse(session, course, latestAt) {
	const timestamp = (await serverTimestamp()) - SIGN_TIMESTAMP_BUFFER_MS;
	if (Date.now() > latestAt) throw new Error("签到窗口已结束");
	const url = `${SIGN_URL}?courseSchedId=${encodeURIComponent(course.id)}&timestamp=${timestamp}&id=${encodeURIComponent(session.userId)}`;
	const data = await fetchJson(url, { method: "GET", headers: { sessionId: session.sessionId, "User-Agent": API_UA } });
	const status = String(data?.STATUS ?? "");
	const signStatus = String(data?.result?.stuSignStatus ?? "");
	const message = String(data?.result?.msg ?? data?.ERRMSG ?? data?.msg ?? data?.message ?? "");
	return {
		success: status === "0" && signStatus === "1",
		message: status === "0" && signStatus === "1" ? "签到成功" : message || "签到失败",
		upstreamStatus: status || String(data?.ERRCODE ?? ""),
		stuSignId: String(data?.result?.stuSignId ?? ""),
		stuSignStatus: signStatus,
	};
}

async function readState() {
	if (!existsSync(STATE_FILE)) return null;
	return JSON.parse(await readFile(STATE_FILE, "utf8"));
}

async function writeState(state) {
	await mkdir(dirname(STATE_FILE), { recursive: true });
	await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function courseLabel(course) {
	const name = course.courseName || "未命名课程";
	const teacher = course.teacherName ? ` / ${course.teacherName}` : "";
	return `${name}${teacher}`;
}

function scheduleMail(state) {
	const lines = [
		`UCAS ${displayDate(state.date)} 课程表`,
		`获取时间：${state.fetchedAt}（${TIMEZONE}）`,
		"",
	];
	if (!state.courses.length) {
		lines.push("今天没有查询到课程。");
	} else {
		state.courses.forEach((course, index) => {
			lines.push(`${index + 1}. ${courseLabel(course)}`);
			lines.push(`   时间：${course.classBeginTime || "未知"} - ${course.classEndTime || "未知"}`);
			lines.push(`   星期：${course.weekDay || "未知"}`);
			lines.push(`   课程 ID：${course.id || "缺失"}`);
			lines.push(`   原签到状态：${course.signStatus || "未知"}`);
		});
	}
	lines.push("", `自动签到窗口：每节课开始前 ${SIGN_BEFORE_MINUTES} 分钟，允许延迟 ${SIGN_GRACE_MINUTES} 分钟。`);
	return `${lines.join("\n")}\n`;
}

function signMail(state, results) {
	const lines = [`UCAS ${displayDate(state.date)} 自动签到结果`, `执行时间：${new Date().toISOString()}（${TIMEZONE}）`, ""];
	for (const result of results) {
		lines.push(`${result.success ? "成功" : "失败"}：${courseLabel(result.course)}`);
		lines.push(`  上课时间：${result.course.classBeginTime || "未知"}`);
		lines.push(`  课程 ID：${result.course.id || "缺失"}`);
		lines.push(`  结果：${result.message}`);
		lines.push(`  累计尝试次数：${result.attemptCount}`);
		if (result.upstreamStatus) lines.push(`  上游状态：${result.upstreamStatus}`);
		if (result.stuSignId) lines.push(`  签到记录：${result.stuSignId}`);
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}

async function fetchCommand() {
	const date = process.argv.includes("--date") ? process.argv[process.argv.indexOf("--date") + 1] : currentDateInTimezone();
	if (!/^\d{8}$/.test(date)) throw new Error(`日期格式错误：${date}`);
	const courses = await fetchSchedule(date);
	const previous = await readState();
	const attempts = previous?.date === date && previous?.attempts && typeof previous.attempts === "object" ? previous.attempts : {};
	const state = {
		version: 1,
		date,
		timezone: TIMEZONE,
		fetchedAt: new Date().toISOString(),
		courses,
		attempts,
	};
	await writeState(state);
	await mkdir(MAIL_DIR, { recursive: true });
	await writeFile(SCHEDULE_MAIL_FILE, scheduleMail(state), "utf8");
	console.log(`已获取 ${displayDate(date)} 课表，共 ${courses.length} 门课`);
}

async function signDueCommand() {
	if (existsSync(SIGN_MAIL_FILE)) unlinkSync(SIGN_MAIL_FILE);
	const state = await readState();
	if (!state) {
		console.log("尚未找到当天课表，跳过签到检查");
		return;
	}
	const today = currentDateInTimezone();
	if (state.date !== today) {
		console.log(`状态日期 ${state.date} 不是今天 ${today}，跳过签到检查`);
		return;
	}

	const now = Date.now();
	const pending = new Map();
	for (const course of state.courses) {
		const key = course.id;
		if (!/^\d{7}$/.test(key)) continue;
		if (state.attempts[key]?.status === "success") continue;
		if (course.signStatus === "1") {
			state.attempts[key] = {
				...state.attempts[key],
				status: "success",
				confirmedAt: new Date().toISOString(),
				message: "课表显示已签到",
			};
			continue;
		}
		const start = parseUcasTime(course.classBeginTime);
		if (!start) continue;
		const dueAt = start - SIGN_BEFORE_MINUTES * 60 * 1000;
		const latestAt = start + SIGN_GRACE_MINUTES * 60 * 1000;
		if (now >= dueAt && now <= latestAt) pending.set(key, { course, latestAt });
		else if (now > latestAt) {
			state.attempts[key] = {
				...state.attempts[key],
				status: "expired",
				message: "超过签到允许时间",
			};
		}
	}
	await writeState(state);

	if (!pending.size) {
		console.log("当前没有需要签到的课程");
		return;
	}

	const results = new Map();
	while (pending.size) {
		for (const [key, { course, latestAt }] of pending) {
			if (Date.now() > latestAt) {
				const previous = state.attempts[key];
				const message = `签到窗口已结束，未签到成功；最后结果：${previous?.message || "尚未提交签到"}`;
				state.attempts[key] = { ...previous, status: "expired", message };
				results.set(key, { ...results.get(key), course, success: false, message, attemptCount: previous?.attemptCount ?? 0 });
				pending.delete(key);
				await writeState(state);
				continue;
			}

			const attemptCount = (state.attempts[key]?.attemptCount ?? 0) + 1;
			let result;
			try {
				// 每次尝试重新登录和获取时间戳，避免沿用失效的会话或旧时间戳。
				const session = await login();
				if (Date.now() > latestAt) throw new Error("签到窗口已结束");
				result = { course, attemptCount, ...(await signCourse(session, course, latestAt)) };
			} catch (error) {
				result = { course, attemptCount, success: false, message: error.message || "签到请求异常", upstreamStatus: "" };
			}
			state.attempts[key] = {
				status: result.success ? "success" : "failed",
				attemptCount,
				attemptedAt: new Date().toISOString(),
				message: result.message,
				upstreamStatus: result.upstreamStatus,
				stuSignId: result.stuSignId,
			};
			results.set(key, result);
			await writeState(state);
			console.log(`${result.success ? "成功" : "失败"} ${key}（第 ${attemptCount} 次）: ${result.message}`);
			if (result.success) pending.delete(key);
		}

		if (pending.size) {
			const nextDeadline = Math.min(...Array.from(pending.values(), (item) => item.latestAt));
			// 每轮重新抽取 0～10 秒（含两端）的随机延迟。
			const retryDelayMs = SIGN_RETRY_INTERVAL_MS + randomInt(0, 11) * 1000;
			const waitMs = Math.min(retryDelayMs, Math.max(0, nextDeadline - Date.now() + 1));
			if (waitMs > 0) {
				console.log(`还有 ${pending.size} 门课程未成功，${Math.ceil(waitMs / 1000)} 秒后重试`);
				await delay(waitMs);
			}
		}
	}

	await mkdir(MAIL_DIR, { recursive: true });
	await writeFile(SIGN_MAIL_FILE, signMail(state, results.values()), "utf8");
	console.log(`已处理 ${results.size} 门到时课程，最终结果已写入邮件报告`);
}

async function main() {
	const command = process.argv[2];
	if (command === "fetch-schedule") return fetchCommand();
	if (command === "sign-due") return signDueCommand();
	throw new Error("用法：node scripts/ucas-automation.mjs fetch-schedule|sign-due [--date YYYYMMDD]");
}

main().catch((error) => {
	console.error(error?.stack || error);
	process.exitCode = 1;
});
