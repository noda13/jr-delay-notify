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

	it("LINE 429 rate-limit: pendingNotify=true survives when LINE returns 429 (lineFailed stays false, pendingNotify remains true)", async () => {
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

		// LINE returned 429 → LineRateLimitError thrown → notified=false for disrupted target
		const disruptedResult = body.results.find(
			(r) => r.id === "hakodate-sapporo",
		);
		expect(disruptedResult).toBeDefined();
		expect(disruptedResult?.status).toBe(1);
		expect(disruptedResult?.notified).toBe(false);

		// KV state: pendingNotify must still be true
		// Formula: pendingNotify = lineFailed || (previous.pendingNotify && sendWanted && !notified)
		//        = false || (true && true && true) = true
		const kvRaw = await env.JR_STATE.get("state:hakodate-sapporo");
		expect(kvRaw).not.toBeNull();
		const state = JSON.parse(kvRaw!) as StoredState;
		expect(state.pendingNotify).toBe(true);
	});
});
