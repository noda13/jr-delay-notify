import { env } from "cloudflare:test";
import { beforeEach } from "vitest";

// @cloudflare/vitest-plugin does not isolate storage per test, so wipe KV to keep tests independent.
beforeEach(async () => {
	let cursor: string | undefined;
	do {
		const page = await env.JR_STATE.list({ cursor });
		await Promise.all(page.keys.map((k) => env.JR_STATE.delete(k.name)));
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
});
