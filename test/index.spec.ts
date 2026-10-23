import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index";
import { shouldNotify } from "../src/state";
import type { StoredState, WatchTarget } from "../src/config";
import { scrapeTarget } from "../src/scraper";
import { sendLineMessage } from "../src/line";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const RUNNING_MESSAGE =
	"jr-delay-notify worker is running.\nGET /check to trigger manually.";

describe("fetch handler", () => {
	it("GET / returns 200 with running message", async () => {
		const request = new IncomingRequest("http://example.com/");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(RUNNING_MESSAGE);
	});

	it("GET /health returns 200 with running message", async () => {
		const request = new IncomingRequest("http://example.com/health");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(RUNNING_MESSAGE);
	});

	it("GET /unknown returns 404", async () => {
		const request = new IncomingRequest("http://example.com/unknown");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("Not Found");
	});

	it("GET /check without X-Check-Secret header returns 403", async () => {
		const testEnv = { ...env, CHECK_SECRET: "test-secret" } as typeof env;
		const request = new IncomingRequest("http://example.com/check");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(403);
		expect(await response.text()).toBe("Forbidden");
	});

	it("GET /check with wrong X-Check-Secret header returns 403", async () => {
		const testEnv = { ...env, CHECK_SECRET: "test-secret" } as typeof env;
		const request = new IncomingRequest("http://example.com/check", {
			headers: { "X-Check-Secret": "wrong-secret" },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(403);
		expect(await response.text()).toBe("Forbidden");
	});
});

describe("shouldNotify", () => {
	const baseState: StoredState = {
		status: 0,
		notifiedAt: "2024-01-01T00:00:00.000Z",
		description: "Normal",
	};

	it("returns false when previous state is null (first run)", () => {
		expect(shouldNotify(null, 0)).toBe(false);
		expect(shouldNotify(null, 1)).toBe(false);
	});

	it("returns false when status is unchanged and no pendingNotify", () => {
		expect(shouldNotify(baseState, 0)).toBe(false);
		expect(shouldNotify({ ...baseState, status: 1 }, 1)).toBe(false);
	});

	it("returns true when status changes NORMAL → DISRUPTED", () => {
		expect(shouldNotify(baseState, 1)).toBe(true);
	});

	it("returns true when status changes DISRUPTED → NORMAL (recovery)", () => {
		expect(shouldNotify({ ...baseState, status: 1 }, 0)).toBe(true);
	});

	it("returns true when status is unchanged but pendingNotify is true", () => {
		expect(shouldNotify({ ...baseState, pendingNotify: true }, 0)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeJrApiResponse(
	senkuStatus: Record<string, number>,
	gaikyo: Array<{ time: string; title: string; honbun: string }> = [],
) {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		text: () =>
			Promise.resolve(
				JSON.stringify({
					time: "2026年06月18日 10時00分現在",
					today: {
						dateText: "2026年06月18日",
						areaStatus: {},
						gaikyo,
						areaComments: [],
						senkuStatus,
					},
					tomorrow: {
						dateText: "2026年06月19日",
						areaStatus: {},
						gaikyo: [],
						areaComments: [],
						senkuStatus: {},
					},
				}),
			),
	};
}

function makeLineApiResponse() {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		text: () => Promise.resolve("{}"),
	};
}

function makeLineRateLimitResponse() {
	return {
		ok: false,
		status: 429,
		statusText: "Too Many Requests",
		text: () =>
			Promise.resolve(
				JSON.stringify({ message: "Too many requests", status: 429 }),
			),
	};
}

// ---------------------------------------------------------------------------
// scrapeTarget tests
// ---------------------------------------------------------------------------

describe("scrapeTarget", () => {
	const target: WatchTarget = {
		id: "hakodate-sapporo",
		label: "函館・千歳線（札幌近郊）",
		areaKey: "spo",
		senkuKey: "hakochise",
	};

	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns NORMAL status (0) with default description when senkuStatus is 0", async () => {
		const mockFetch = vi.fn().mockResolvedValue(
			makeJrApiResponse({ hakochise: 0, airport: 0 }),
		);
		vi.stubGlobal("fetch", mockFetch);

		const result = await scrapeTarget(target);

		expect(result.status).toBe(0);
		expect(result.description).toBe("現在、遅れに関する情報はありません。");
		expect(result.target).toBe(target);
		expect(result.updatedAt).toBe("2026年06月18日 10時00分現在");
	});

	it("returns DISRUPTED status (1) with 'エリア概況: ' prefixed description when senkuStatus is 1 and gaikyo has entries", async () => {
		const gaikyo = [
			{
				time: "10:00",
				title: "運転状況",
				honbun: "函館本線で遅延が発生しています。",
			},
		];
		const mockFetch = vi.fn().mockResolvedValue(
			makeJrApiResponse({ hakochise: 1, airport: 0 }, gaikyo),
		);
		vi.stubGlobal("fetch", mockFetch);

		const result = await scrapeTarget(target);

		expect(result.status).toBe(1);
		expect(result.description).toBe(
			"エリア概況: 函館本線で遅延が発生しています。",
		);
	});

	it("throws on non-JSON response (maintenance page scenario)", async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: () => Promise.resolve("<html>Maintenance</html>"),
		});
		vi.stubGlobal("fetch", mockFetch);

		await expect(scrapeTarget(target)).rejects.toThrow(
			/Failed to parse JSON for target "hakodate-sapporo"/,
		);
	});
});

// ---------------------------------------------------------------------------
// /check integration tests
// ---------------------------------------------------------------------------

// All tests in this block send the correct X-Check-Secret header,
// exercising the timingSafeStringEqual(provided, secret) === true path.
describe("fetch handler /check integration", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("first run (no KV state): GET /check with correct secret returns 200, notified=false for all targets", async () => {
		const mockFetch = vi.fn().mockImplementation((url: string) => {
			if (String(url).includes("jrhokkaido")) {
				return Promise.resolve(
					makeJrApiResponse({ hakochise: 0, airport: 0 }),
				);
			}
			return Promise.resolve(makeLineApiResponse());
		});
		vi.stubGlobal("fetch", mockFetch);

		const testEnv = {
			...env,
			CHECK_SECRET: "test-secret",
			LINE_CHANNEL_ACCESS_TOKEN: "fake-token",
		} as typeof env;

		const request = new IncomingRequest("http://example.com/check", {
			headers: { "X-Check-Secret": "test-secret" },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			ok: boolean;
			results: Array<{
				id: string;
				status: number;
				notified: boolean;
				description: string;
				label: string;
			}>;
		};
		expect(body.ok).toBe(true);
		expect(body.results).toHaveLength(2);
		for (const result of body.results) {
			expect(result.notified).toBe(false);
		}
	});

	it("NORMAL→DISRUPTED transition: pre-seeded KV with NORMAL state, JR API returns DISRUPTED → notified=true for disrupted target", async () => {
		// Pre-seed KV with NORMAL state for both targets
		await env.JR_STATE.put(
			"state:hakodate-sapporo",
			JSON.stringify({
				status: 0,
				notifiedAt: "2024-01-01T00:00:00.000Z",
				description: "Normal",
			}),
		);
		await env.JR_STATE.put(
			"state:spo-airport",
			JSON.stringify({
				status: 0,
				notifiedAt: "2024-01-01T00:00:00.000Z",
				description: "Normal",
			}),
		);

		// Mock JR API to return DISRUPTED for hakochise, NORMAL for airport
		const mockFetch = vi.fn().mockImplementation((url: string) => {
			if (String(url).includes("jrhokkaido")) {
				return Promise.resolve(
					makeJrApiResponse(
						{ hakochise: 1, airport: 0 },
						[
							{
								time: "10:00",
								title: "運転状況",
								honbun: "函館本線で遅延が発生しています。",
							},
						],
					),
				);
			}
			return Promise.resolve(makeLineApiResponse());
		});
		vi.stubGlobal("fetch", mockFetch);

		const testEnv = {
			...env,
			CHECK_SECRET: "test-secret",
			LINE_CHANNEL_ACCESS_TOKEN: "fake-token",
		} as typeof env;

		const request = new IncomingRequest("http://example.com/check", {
			headers: { "X-Check-Secret": "test-secret" },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			ok: boolean;
			results: Array<{
				id: string;
				status: number;
				notified: boolean;
				description: string;
				label: string;
			}>;
		};
		expect(body.ok).toBe(true);

		const disruptedResult = body.results.find(
			(r) => r.id === "hakodate-sapporo",
		);
		expect(disruptedResult).toBeDefined();
		expect(disruptedResult?.status).toBe(1);
		expect(disruptedResult?.notified).toBe(true);

		const normalResult = body.results.find((r) => r.id === "spo-airport");
		expect(normalResult).toBeDefined();
		expect(normalResult?.status).toBe(0);
		expect(normalResult?.notified).toBe(false);
	});

	it("DISRUPTED→NORMAL recovery: pre-seeded KV with DISRUPTED state, JR API returns NORMAL, NOTIFY_ON_RECOVERY=true → notified=true for recovered target", async () => {
		// Pre-seed KV: hakodate-sapporo was disrupted, spo-airport was normal
		await env.JR_STATE.put(
			"state:hakodate-sapporo",
			JSON.stringify({
				status: 1,
				notifiedAt: "2024-01-01T00:00:00.000Z",
				description: "遅延中",
			}),
		);
		await env.JR_STATE.put(
			"state:spo-airport",
			JSON.stringify({
				status: 0,
				notifiedAt: "2024-01-01T00:00:00.000Z",
				description: "Normal",
			}),
		);

		// Mock JR API: both targets now NORMAL (recovery)
		const mockFetch = vi.fn().mockImplementation((url: string) => {
			if (String(url).includes("jrhokkaido")) {
				return Promise.resolve(
					makeJrApiResponse({ hakochise: 0, airport: 0 }),
				);
			}
			return Promise.resolve(makeLineApiResponse());
		});
		vi.stubGlobal("fetch", mockFetch);

		const testEnv = {
			...env,
			CHECK_SECRET: "test-secret",
			LINE_CHANNEL_ACCESS_TOKEN: "fake-token",
			NOTIFY_ON_RECOVERY: "true",
		} as typeof env;

		const request = new IncomingRequest("http://example.com/check", {
			headers: { "X-Check-Secret": "test-secret" },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			ok: boolean;
			results: Array<{
				id: string;
				status: number;
				notified: boolean;
				description: string;
				label: string;
			}>;
		};
		expect(body.ok).toBe(true);

		// hakodate-sapporo recovered: status changed 1→0, NOTIFY_ON_RECOVERY=true → notified
		const recoveredResult = body.results.find(
			(r) => r.id === "hakodate-sapporo",
		);
		expect(recoveredResult).toBeDefined();
		expect(recoveredResult?.status).toBe(0);
		expect(recoveredResult?.notified).toBe(true);

		// spo-airport unchanged (still NORMAL) → not notified
		const unchangedResult = body.results.find((r) => r.id === "spo-airport");
		expect(unchangedResult).toBeDefined();
		expect(unchangedResult?.status).toBe(0);
		expect(unchangedResult?.notified).toBe(false);
	});

	it("pendingNotify=true retry: pre-seeded KV with pendingNotify=true, JR API returns same DISRUPTED status → notified=true (retry succeeded)", async () => {
		// Pre-seed KV: hakodate-sapporo was disrupted but LINE send failed (pendingNotify=true)
		await env.JR_STATE.put(
			"state:hakodate-sapporo",
			JSON.stringify({
				status: 1,
				notifiedAt: "",
				description: "遅延中",
				pendingNotify: true,
			}),
		);
		await env.JR_STATE.put(
			"state:spo-airport",
			JSON.stringify({
				status: 0,
				notifiedAt: "2024-01-01T00:00:00.000Z",
				description: "Normal",
			}),
		);

		// Mock JR API: hakodate-sapporo still DISRUPTED (status unchanged), airport still NORMAL
		const mockFetch = vi.fn().mockImplementation((url: string) => {
			if (String(url).includes("jrhokkaido")) {
				return Promise.resolve(
					makeJrApiResponse({ hakochise: 1, airport: 0 }),
				);
			}
			return Promise.resolve(makeLineApiResponse());
		});
		vi.stubGlobal("fetch", mockFetch);

		const testEnv = {
			...env,
			CHECK_SECRET: "test-secret",
			LINE_CHANNEL_ACCESS_TOKEN: "fake-token",
		} as typeof env;

		const request = new IncomingRequest("http://example.com/check", {
			headers: { "X-Check-Secret": "test-secret" },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			ok: boolean;
			results: Array<{
				id: string;
				status: number;
				notified: boolean;
				description: string;
				label: string;
			}>;
		};
		expect(body.ok).toBe(true);

		// hakodate-sapporo: status unchanged (1→1) but pendingNotify=true triggers retry → notified
		const retryResult = body.results.find((r) => r.id === "hakodate-sapporo");
		expect(retryResult).toBeDefined();
		expect(retryResult?.status).toBe(1);
		expect(retryResult?.notified).toBe(true);

		// spo-airport unchanged (still NORMAL) → not notified
		const normalResult = body.results.find((r) => r.id === "spo-airport");
		expect(normalResult).toBeDefined();
		expect(normalResult?.status).toBe(0);
		expect(normalResult?.notified).toBe(false);
	});

	it("LINE 429 rate-limit: pendingNotify=true survives when LINE returns 429 (lineFailed=true, pendingNotify remains true)", async () => {
		// Pre-seed KV: hakodate-sapporo disrupted with pendingNotify=true (prior retry-pending state)
		await env.JR_STATE.put(
			"state:hakodate-sapporo",
			JSON.stringify({
				status: 1,
				notifiedAt: "",
				description: "遅延中",
				pendingNotify: true,
			}),
		);
		await env.JR_STATE.put(
			"state:spo-airport",
			JSON.stringify({
				status: 0,
				notifiedAt: "2024-01-01T00:00:00.000Z",
				description: "Normal",
			}),
		);

		// Mock: JR API still returns DISRUPTED; LINE API returns 429
		const mockFetch = vi.fn().mockImplementation((url: string) => {
			if (String(url).includes("jrhokkaido")) {
				return Promise.resolve(
					makeJrApiResponse({ hakochise: 1, airport: 0 }),
				);
			}
			if (String(url).includes("api.line.me")) {
				return Promise.resolve(makeLineRateLimitResponse());
			}
			return Promise.resolve(makeLineApiResponse());
		});
		vi.stubGlobal("fetch", mockFetch);

		const testEnv = {
			...env,
			CHECK_SECRET: "test-secret",
			LINE_CHANNEL_ACCESS_TOKEN: "fake-token",
		} as typeof env;

		const request = new IncomingRequest("http://example.com/check", {
			headers: { "X-Check-Secret": "test-secret" },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			ok: boolean;
			results: Array<{
				id: string;
				status: number;
				notified: boolean;
				description: string;
				label: string;
			}>;
		};
		expect(body.ok).toBe(true);

		// LINE returned 429 → LineRateLimitError thrown → lineFailed=true → notified=false
		const disruptedResult = body.results.find(
			(r) => r.id === "hakodate-sapporo",
		);
		expect(disruptedResult).toBeDefined();
		expect(disruptedResult?.status).toBe(1);
		expect(disruptedResult?.notified).toBe(false);

		// KV state: pendingNotify must still be true
		// Formula: pendingNotify = lineFailed || (previous.pendingNotify && sendWanted && !notified)
		//        = true || (true && true && true) = true
		const kvRaw = await env.JR_STATE.get("state:hakodate-sapporo");
		expect(kvRaw).not.toBeNull();
		const state = JSON.parse(kvRaw!) as StoredState;
		expect(state.pendingNotify).toBe(true);
	});

	it("LINE 429 rate-limit on NEW disruption: no prior pendingNotify, LINE returns 429 → pendingNotify=true stored (not dropped)", async () => {
		// Pre-seed KV: hakodate-sapporo was NORMAL (no pendingNotify) — fresh disruption scenario
		await env.JR_STATE.put(
			"state:hakodate-sapporo",
			JSON.stringify({
				status: 0,
				notifiedAt: "2024-01-01T00:00:00.000Z",
				description: "Normal",
				pendingNotify: false,
			}),
		);
		await env.JR_STATE.put(
			"state:spo-airport",
			JSON.stringify({
				status: 0,
				notifiedAt: "2024-01-01T00:00:00.000Z",
				description: "Normal",
			}),
		);

		// Mock: JR API returns DISRUPTED (NORMAL→DISRUPTED transition); LINE API returns 429
		const mockFetch = vi.fn().mockImplementation((url: string) => {
			if (String(url).includes("jrhokkaido")) {
				return Promise.resolve(
					makeJrApiResponse(
						{ hakochise: 1, airport: 0 },
						[
							{
								time: "10:00",
								title: "運転状況",
								honbun: "函館本線で遅延が発生しています。",
							},
						],
					),
				);
			}
			if (String(url).includes("api.line.me")) {
				return Promise.resolve(makeLineRateLimitResponse());
			}
			return Promise.resolve(makeLineApiResponse());
		});
		vi.stubGlobal("fetch", mockFetch);

		const testEnv = {
			...env,
			CHECK_SECRET: "test-secret",
			LINE_CHANNEL_ACCESS_TOKEN: "fake-token",
		} as typeof env;

		const request = new IncomingRequest("http://example.com/check", {
			headers: { "X-Check-Secret": "test-secret" },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			ok: boolean;
			results: Array<{
				id: string;
				status: number;
				notified: boolean;
				description: string;
				label: string;
			}>;
		};
		expect(body.ok).toBe(true);

		// LINE returned 429 → lineFailed=true → notified=false
		const disruptedResult = body.results.find(
			(r) => r.id === "hakodate-sapporo",
		);
		expect(disruptedResult).toBeDefined();
		expect(disruptedResult?.status).toBe(1);
		expect(disruptedResult?.notified).toBe(false);

		// KV state: pendingNotify must be true so the notification is retried next run
		// Formula: pendingNotify = lineFailed || (previous.pendingNotify && sendWanted && !notified)
		//        = true || (false && true && true) = true
		// Without the fix (lineFailed=false): = false || (false && true && true) = false → permanently lost
		const kvRaw = await env.JR_STATE.get("state:hakodate-sapporo");
		expect(kvRaw).not.toBeNull();
		const state = JSON.parse(kvRaw!) as StoredState;
		expect(state.pendingNotify).toBe(true);
	});
});

describe("sendLineMessage routing", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("broadcasts without `to`", async () => {
		const mockFetch = vi.fn().mockResolvedValue(makeLineApiResponse());
		vi.stubGlobal("fetch", mockFetch);
		await sendLineMessage("tok", "hi");
		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toBe("https://api.line.me/v2/bot/message/broadcast");
		expect(JSON.parse(init.body)).not.toHaveProperty("to");
	});

	it("uses push API with `to`", async () => {
		const mockFetch = vi.fn().mockResolvedValue(makeLineApiResponse());
		vi.stubGlobal("fetch", mockFetch);
		await sendLineMessage("tok", "hi", "U123");
		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toBe("https://api.line.me/v2/bot/message/push");
		expect(JSON.parse(init.body).to).toBe("U123");
	});
});

describe("scheduled heartbeat", () => {
	const HEARTBEAT = "https://hc.example.com/ping/abc";

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function stubFetch(jrOk: boolean) {
		const mockFetch = vi.fn().mockImplementation((url: string) => {
			if (String(url).includes("jrhokkaido")) {
				return Promise.resolve(
					jrOk
						? makeJrApiResponse({ hakochise: 0, airport: 0 })
						: {
								ok: false,
								status: 500,
								statusText: "ERR",
								text: () => Promise.resolve(""),
							},
				);
			}
			return Promise.resolve(makeLineApiResponse());
		});
		vi.stubGlobal("fetch", mockFetch);
		return mockFetch;
	}

	const run = async (testEnv: typeof env) => {
		await worker.scheduled(
			{} as ScheduledController,
			testEnv,
			createExecutionContext(),
		);
	};

	it("pings HEARTBEAT_URL after a fully successful run", async () => {
		const mockFetch = stubFetch(true);
		await run({ ...env, HEARTBEAT_URL: HEARTBEAT } as typeof env);
		expect(mockFetch.mock.calls.some(([u]) => u === HEARTBEAT)).toBe(true);
	});

	it("does not ping when a target failed", async () => {
		const mockFetch = stubFetch(false);
		await run({
			...env,
			HEARTBEAT_URL: HEARTBEAT,
			LINE_CHANNEL_ACCESS_TOKEN: "tok",
		} as typeof env);
		expect(mockFetch.mock.calls.some(([u]) => u === HEARTBEAT)).toBe(false);
	});

	it("does not ping when HEARTBEAT_URL is unset", async () => {
		const mockFetch = stubFetch(true);
		await run(env);
		expect(
			mockFetch.mock.calls.every(([u]) => String(u).includes("jrhokkaido")),
		).toBe(true);
	});

	async function seedNormal() {
		for (const id of ["hakodate-sapporo", "spo-airport"]) {
			await env.JR_STATE.put(
				`state:${id}`,
				JSON.stringify({ status: 0, description: "Normal" }),
			);
		}
	}

	function stubDisruptedWithLine(lineResponse: unknown) {
		const mockFetch = vi.fn().mockImplementation((url: string) => {
			if (String(url).includes("jrhokkaido")) {
				return Promise.resolve(
					makeJrApiResponse({ hakochise: 1, airport: 0 }),
				);
			}
			return Promise.resolve(lineResponse);
		});
		vi.stubGlobal("fetch", mockFetch);
		return mockFetch;
	}

	it("does not ping when a wanted LINE notification fails", async () => {
		await seedNormal();
		const mockFetch = stubDisruptedWithLine(makeLineRateLimitResponse());
		await run({
			...env,
			HEARTBEAT_URL: HEARTBEAT,
			LINE_CHANNEL_ACCESS_TOKEN: "tok",
		} as typeof env);
		expect(mockFetch.mock.calls.some(([u]) => u === HEARTBEAT)).toBe(false);
	});

	it("does not ping when a notification is wanted but the token is missing", async () => {
		await seedNormal();
		const mockFetch = stubDisruptedWithLine(makeLineApiResponse());
		await run({
			...env,
			HEARTBEAT_URL: HEARTBEAT,
			LINE_CHANNEL_ACCESS_TOKEN: "",
		} as typeof env);
		expect(mockFetch.mock.calls.some(([u]) => u === HEARTBEAT)).toBe(false);
	});

	it("pings when a wanted LINE notification succeeds", async () => {
		await seedNormal();
		const mockFetch = stubDisruptedWithLine(makeLineApiResponse());
		await run({
			...env,
			HEARTBEAT_URL: HEARTBEAT,
			LINE_CHANNEL_ACCESS_TOKEN: "tok",
		} as typeof env);
		expect(mockFetch.mock.calls.some(([u]) => u === HEARTBEAT)).toBe(true);
	});
});

describe("review fixes", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("missing token keeps pendingNotify=true so heartbeat stays silent on later runs", async () => {
		for (const id of ["hakodate-sapporo", "spo-airport"]) {
			await env.JR_STATE.put(
				`state:${id}`,
				JSON.stringify({ status: 0, description: "Normal" }),
			);
		}
		const mockFetch = vi.fn().mockImplementation((url: string) =>
			Promise.resolve(
				String(url).includes("jrhokkaido")
					? makeJrApiResponse({ hakochise: 1, airport: 0 })
					: makeLineApiResponse(),
			),
		);
		vi.stubGlobal("fetch", mockFetch);
		const testEnv = {
			...env,
			HEARTBEAT_URL: "https://hc.example.com/ping/abc",
			LINE_CHANNEL_ACCESS_TOKEN: "",
		} as typeof env;

		for (let i = 0; i < 2; i++) {
			await worker.scheduled(
				{} as ScheduledController,
				testEnv,
				createExecutionContext(),
			);
		}

		const state = JSON.parse(
			(await env.JR_STATE.get("state:hakodate-sapporo"))!,
		) as StoredState;
		expect(state.pendingNotify).toBe(true);
		expect(
			mockFetch.mock.calls.some(([u]) => u === "https://hc.example.com/ping/abc"),
		).toBe(false);
	});

	it("POST /check returns 405 before authentication", async () => {
		const request = new IncomingRequest("http://example.com/check", {
			method: "POST",
			headers: { "X-Check-Secret": "test-secret" },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			request,
			{ ...env, CHECK_SECRET: "test-secret" } as typeof env,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("GET");
	});

	it("sendLineMessage truncates text over 5000 characters", async () => {
		const mockFetch = vi.fn().mockResolvedValue(makeLineApiResponse());
		vi.stubGlobal("fetch", mockFetch);
		await sendLineMessage("tok", "あ".repeat(6000));
		const sent = JSON.parse(mockFetch.mock.calls[0][1].body).messages[0].text;
		expect(sent).toHaveLength(5000);
		expect(sent.endsWith("…")).toBe(true);
	});
});
