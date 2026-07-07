// End-to-end test for the `manage_scheduled_jobs` tool: instantiates the real
// extension with a mock pi (same pattern as tool-description-mode.test.ts)
// inside a temp cwd, fires session_start so the scheduler binds a real
// on-disk ScheduleStore, then drives the tool through list/pause/resume/
// cancel against a job created via the Agent tool's `schedule` param.
//
// This is the headless-agent management surface — a broken cancel path means
// scheduled jobs are immortal for SDK sessions with no TUI — so the contract
// is tested at the registered-tool level, not against scheduler internals.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";

function makePi() {
	const tools = new Map<string, any>();
	const handlers = new Map<string, any[]>();

	return {
		pi: {
			registerMessageRenderer: vi.fn(),
			registerTool: vi.fn((tool: any) => {
				tools.set(tool.name, tool);
			}),
			registerCommand: vi.fn(),
			on: vi.fn((event: string, handler: any) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			}),
			events: {
				emit: vi.fn(),
				on: vi.fn(() => vi.fn()),
			},
			appendEntry: vi.fn(),
			sendMessage: vi.fn(),
		} as any,
		tools,
		handlers,
	};
}

function makeCtx(cwd: string) {
	return {
		cwd,
		hasUI: false,
		ui: {},
		modelRegistry: { find: vi.fn(), getAll: () => [], getAvailable: () => [] },
		sessionManager: { getSessionId: () => "sess-manage-jobs" },
	} as any;
}

function text(result: any): string {
	return result?.content?.[0]?.text ?? "";
}

describe("manage_scheduled_jobs", () => {
	let tmpDir: string;
	let hermeticAgentDir: string;
	let prevCwd: string;
	let prevAgentDir: string | undefined;
	let prevHome: string | undefined;
	let shutdown: (() => Promise<void>) | undefined;

	async function setup(settings?: Record<string, unknown>) {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-manage-jobs-"));
		hermeticAgentDir = mkdtempSync(join(tmpdir(), "pi-manage-jobs-agentdir-"));
		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		prevHome = process.env.HOME;
		process.env.PI_CODING_AGENT_DIR = hermeticAgentDir;
		process.env.HOME = hermeticAgentDir;
		prevCwd = process.cwd();
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		if (settings) {
			writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify(settings));
		}
		process.chdir(tmpDir);

		const { pi, tools, handlers } = makePi();
		subagentsExtension(pi);
		const ctx = makeCtx(tmpDir);
		for (const h of handlers.get("session_start") ?? []) await h({}, ctx);
		shutdown = async () => {
			for (const h of handlers.get("session_shutdown") ?? []) await h({}, ctx);
		};
		return { tools, ctx };
	}

	afterEach(async () => {
		await shutdown?.();
		shutdown = undefined;
		process.chdir(prevCwd);
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		rmSync(tmpDir, { recursive: true, force: true });
		rmSync(hermeticAgentDir, { recursive: true, force: true });
	});

	it("is not registered when scheduling is disabled", async () => {
		const { tools } = await setup({ schedulingEnabled: false });
		expect(tools.has("manage_scheduled_jobs")).toBe(false);
	});

	it("lists, pauses, resumes, and cancels a scheduled job", async () => {
		const { tools, ctx } = await setup();
		const manage = tools.get("manage_scheduled_jobs");
		const agent = tools.get("Agent");
		expect(manage).toBeDefined();
		const signal = new AbortController().signal;
		const run = async (params: any) => text(await manage.execute("tc", params, signal, vi.fn(), ctx));

		expect(await run({ action: "list" })).toBe("No scheduled jobs.");

		// Create a job through the Agent tool's schedule param (the only
		// LLM-facing creation path) so the whole loop is agent-drivable.
		const created = text(
			await agent.execute(
				"tc-create",
				{ description: "test monitor", prompt: "check things", subagent_type: "general-purpose", schedule: "30m" },
				signal,
				vi.fn(),
				ctx,
			),
		);
		expect(created).toContain("Scheduled \"test monitor\"");
		expect(created).toContain("manage_scheduled_jobs");
		const id = created.match(/id: ([A-Za-z0-9_-]+)/)?.[1];
		expect(id).toBeTruthy();

		const listed = await run({ action: "list" });
		expect(listed).toContain(id);
		expect(listed).toContain("[enabled]");

		expect(await run({ action: "pause", job_id: id })).toContain("Paused");
		expect(await run({ action: "list" })).toContain("[paused]");
		expect(await run({ action: "pause", job_id: id })).toContain("already paused");

		expect(await run({ action: "resume", job_id: id })).toContain("Resumed");
		expect(await run({ action: "list" })).toContain("[enabled]");

		expect(await run({ action: "cancel", job_id: id })).toContain("Cancelled and removed");
		expect(await run({ action: "list" })).toBe("No scheduled jobs.");

		// The on-disk store must agree — cancellation survives session restarts.
		const storeFile = join(tmpDir, ".pi", "subagent-schedules", "sess-manage-jobs.json");
		const stored = JSON.parse(readFileSync(storeFile, "utf-8"));
		expect(stored.jobs).toHaveLength(0);
	});

	it("rejects mutations without a job_id and unknown job ids", async () => {
		const { tools, ctx } = await setup();
		const manage = tools.get("manage_scheduled_jobs");
		const signal = new AbortController().signal;
		const run = async (params: any) => text(await manage.execute("tc", params, signal, vi.fn(), ctx));

		expect(await run({ action: "cancel" })).toContain("`job_id` is required");
		expect(await run({ action: "cancel", job_id: "missing1" })).toContain('No scheduled job with id "missing1"');
	});
});
