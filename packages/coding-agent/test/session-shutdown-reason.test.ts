/**
 * Shutdown-intent contract for `session_shutdown`.
 *
 * Failure mode if this regresses: a macOS reboot (SIGTERM), a crash, or a
 * programmatic dispose is reported to extensions as an intentional quit, so
 * hosts like Herdr release resumable native references that should have
 * survived the restart — or, conversely, an explicit /quit never releases.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { createSessionTeardown } from "@oh-my-pi/pi-coding-agent/modes/session-teardown";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { shutdownHandlerTui } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-lifecycle";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

interface Harness {
	session: AgentSession;
	seen: unknown[];
}

const fixtures: Array<{ session?: AgentSession; tempDir?: TempDir; authStorage?: AuthStorage }> = [];

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.session?.dispose().catch(() => undefined);
		fixture.authStorage?.close();
		fixture.tempDir?.removeSync();
	}
	vi.restoreAllMocks();
});

async function makeSession(): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-shutdown-reason-");
	const authStorage = createInMemoryAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled Anthropic model to exist");
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const runtime = new ExtensionRuntime();
	const seen: unknown[] = [];
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("session_shutdown", event => {
				if (event && typeof event === "object" && "reason" in event) {
					seen.push(event.reason);
				} else {
					seen.push(undefined);
				}
			});
		},
		tempDir.path(),
		new EventBus(),
		runtime,
		"shutdown-reason-capture",
	);
	const { session } = await createAgentSession({
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false, "async.enabled": false }),
		modelRegistry,
		model,
		preloadedExtensions: { extensions: [extension], errors: [], runtime },
		enableLsp: false,
		enableMCP: false,
		skipPythonPreflight: true,
		skills: [],
		rules: [],
		preloadedCustomToolPaths: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		toolNames: [],
	});
	fixtures.push({ session, tempDir, authStorage });
	return { session, seen };
}

function makeInputContext() {
	const shutdown = vi.fn(async (_options?: { quit?: boolean }) => {});
	const ctx = {
		sessionManager: { flushSync: vi.fn() },
		isShuttingDown: false,
		teardownFailed: false,
		lastSigintTime: 0,
		shutdown,
		clearEditor: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, raw: ctx as unknown as Record<string, unknown>, shutdown };
}

describe("session_shutdown intent", () => {
	it("defaults programmatic disposal to dispose so hosts keep resumable refs", async () => {
		const { session, seen } = await makeSession();

		await session.dispose();

		expect(seen).toEqual(["dispose"]);
	});

	it("emits quit for an explicit interactive quit so hosts release", async () => {
		const { session, seen } = await makeSession();

		await session.dispose({ shutdownReason: "quit" });

		expect(seen).toEqual(["quit"]);
	});

	it("emits signal for SIGTERM teardown, never quit", async () => {
		const { session, seen } = await makeSession();

		await session.dispose({ reason: postmortem.Reason.SIGTERM });

		expect(seen).toEqual(["signal"]);
	});

	it("emits fatal for an uncaught exception, never quit", async () => {
		const { session, seen } = await makeSession();

		await session.dispose({ reason: postmortem.Reason.UNCAUGHT_EXCEPTION });

		expect(seen).toEqual(["fatal"]);
	});

	it("emits shutdown exactly once; a late quit never relabels the first dispose", async () => {
		const { session, seen } = await makeSession();

		await session.dispose();
		await session.dispose({ shutdownReason: "quit" });

		expect(seen).toEqual(["dispose"]);
	});

	it("routes /quit through shutdown with quit intent", () => {
		const shutdown = vi.fn();
		const setText = vi.fn();
		// The quit handler clears owned draft text before shutting down.
		const runtime = {
			ctx: { shutdown, editor: { setText }, requestRender: vi.fn() },
		} as unknown as Parameters<typeof shutdownHandlerTui>[1];

		shutdownHandlerTui({ name: "quit", args: "", text: "/quit" }, runtime);

		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(shutdown).toHaveBeenCalledWith({ quit: true });
	});

	it("routes /exit through shutdown with quit intent", () => {
		const shutdown = vi.fn();
		const setText = vi.fn();
		const runtime = {
			ctx: { shutdown, editor: { setText }, requestRender: vi.fn() },
		} as unknown as Parameters<typeof shutdownHandlerTui>[1];

		shutdownHandlerTui({ name: "exit", args: "", text: "/exit" }, runtime);

		expect(shutdown).toHaveBeenCalledWith({ quit: true });
	});

	it("marks Ctrl+D as an explicit quit while programmatic disposal stays dispose", async () => {
		const { ctx, shutdown } = makeInputContext();
		const controller = new InputController(ctx);
		controller.handleCtrlD();

		expect(shutdown).toHaveBeenCalledWith({ quit: true });

		const { session, seen } = await makeSession();
		await session.dispose();
		expect(seen).toEqual(["dispose"]);
	});

	it("marks double Ctrl+C as an explicit quit; the first press only clears the editor", () => {
		const { ctx, raw, shutdown } = makeInputContext();
		const controller = new InputController(ctx);

		controller.handleCtrlC();
		expect(shutdown).not.toHaveBeenCalled();

		raw["lastSigintTime"] = Date.now();
		controller.handleCtrlC();
		expect(shutdown).toHaveBeenCalledWith({ quit: true });
	});

	it("threads an explicit quit intent from interactive teardown into disposal", async () => {
		const received: Array<{ reason: postmortem.Reason | undefined; shutdownReason: string | undefined }> = [];
		const teardown = createSessionTeardown({
			getDraftText: () => "",
			beginDispose: () => {},
			saveDraft: async () => {},
			disposeSession: async (reason, shutdownReason) => {
				received.push({ reason, shutdownReason });
			},
		});

		await teardown(undefined, "quit");

		expect(received).toEqual([{ reason: undefined, shutdownReason: "quit" }]);
	});

	it("forwards a signal reason without a quit label", async () => {
		const received: Array<{ reason: postmortem.Reason | undefined; shutdownReason: string | undefined }> = [];
		const teardown = createSessionTeardown({
			getDraftText: () => "",
			beginDispose: () => {},
			saveDraft: async () => {},
			disposeSession: async (reason, shutdownReason) => {
				received.push({ reason, shutdownReason });
			},
		});

		await teardown(postmortem.Reason.SIGTERM);

		expect(received).toEqual([{ reason: postmortem.Reason.SIGTERM, shutdownReason: undefined }]);
	});
});
