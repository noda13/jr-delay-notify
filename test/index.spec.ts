import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import { shouldNotify } from "../src/state";
import type { StoredState } from "../src/config";

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
