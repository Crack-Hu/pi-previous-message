/**
 * Last Message Recall
 *
 * After a configurable period without any activity (no keystrokes, no agent
 * output), show the previous message so you remember what you were doing when
 * you come back to the session. Typing does not dismiss it; submitting a prompt
 * with Enter does.
 *
 * Placement:
 *   "widget"  - above the input editor (part of the layout, covers nothing)
 *   "overlay" - floating window pinned to the top edge of the terminal
 *
 * Commands:
 *   /previous-message                          show the reminder now
 *   /previous-message hide                     hide it
 *   /previous-message on | off                 enable / disable the reminder
 *   /previous-message status                   show current settings
 *   /previous-message SetLines 4               body lines shown (1-8)
 *   /previous-message SetInterval 5m           delay before the reminder (30s, 5m, 2h)
 *   /previous-message SetPlacement widget      widget (above editor) or overlay (top edge)
 *   /previous-message SetAutoShow on|off       show the reminder when opening a past session
 *   /previous-message SetBrightness 0 2        brightness -5..5: 0 dim, 2 muted, 5 text
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { mixColors, rgbColor, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const WIDGET_KEY = "previous-message";
/** Follows PI_CODING_AGENT_DIR when set, otherwise the default agent dir. */
const CONFIG_PATH = path.join(getAgentDir(), "previous-message.json");
const DEFAULT_IDLE_MINUTES = 10;
const DEFAULT_MAX_LINES = 4;
/** Header (1) + body must stay within pi's 10-line widget cap. */
const MAX_BODY_LINES = 8;
const MAX_TEXT_CHARS = 1200;
/** Same left inset pi uses for transcript messages (outputPad). */
const CONTENT_INDENT = 1;
/** The block follows the page width at this ratio, so it reflows on resize. */
const CONTENT_WIDTH_RATIO = 0.66;
const MIN_CONTENT_WIDTH = 40;

type Placement = "widget" | "overlay";
type TimeUnit = "s" | "m" | "h";
/** Brightness scale: -5 = background, 0 = dim, 2 = muted, 5 = text. */
const BRIGHTNESS_MAX = 5;
const BRIGHTNESS_MIN = -5;
const BRIGHTNESS_MUTED = 2;
type Shown = Placement | undefined;

interface Config {
	enabled: boolean;
	idleMinutes: number;
	/** Unit the delay was configured with; also used by the "ago" label. */
	intervalUnit: TimeUnit;
	placement: Placement;
	/** Body lines shown under the header, 1..MAX_BODY_LINES. */
	maxLines: number;
	/** Show the reminder immediately when a past session is opened. */
	autoShow: boolean;
	/** Brightness of the rule and caption, 0-10. */
	captionLevel: number;
	/** Brightness of the message body, 0-10. */
	bodyLevel: number;
}

const DEFAULT_CONFIG: Config = {
	enabled: true,
	idleMinutes: DEFAULT_IDLE_MINUTES,
	intervalUnit: "m",
	placement: "widget",
	maxLines: DEFAULT_MAX_LINES,
	autoShow: true,
	captionLevel: 0,
	bodyLevel: BRIGHTNESS_MUTED,
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	const parsed = typeof value === "number" ? Math.round(value) : Number.NaN;
	return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

/** Returns a painter for a brightness level, blending between theme anchors. */
function tonePainter(theme: Theme, level: number): (text: string) => string {
	const value = clampInt(level, BRIGHTNESS_MIN, BRIGHTNESS_MAX, BRIGHTNESS_MUTED);
	if (value === 0) return (text) => theme.fg("dim", text);
	if (value === BRIGHTNESS_MUTED) return (text) => theme.fg("muted", text);
	if (value === BRIGHTNESS_MAX) return (text) => theme.fg("text", text);
	// Below 0 fades toward the background; the theme has no background token, so
	// approximate it from the appearance.
	const color =
		value < 0
			? mixColors(
					theme.colors.dim,
					theme.appearance === "light" ? rgbColor(255, 255, 255) : rgbColor(0, 0, 0),
					-value / -BRIGHTNESS_MIN,
					"oklch",
				)
			: value < BRIGHTNESS_MUTED
				? mixColors(theme.colors.dim, theme.colors.muted, value / BRIGHTNESS_MUTED, "oklch")
				: mixColors(theme.colors.muted, theme.colors.text, (value - BRIGHTNESS_MUTED) / (BRIGHTNESS_MAX - BRIGHTNESS_MUTED), "oklch");
	return (text) => theme.style(text, { fg: color });
}

// --- persisted config -------------------------------------------------------

function readConfigFile(filePath: string): Partial<Config> | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<Config>;
	} catch {
		return undefined;
	}
}

function loadConfig(): Config {
	const raw = readConfigFile(CONFIG_PATH);
	if (raw) {
		return {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
			idleMinutes:
				typeof raw.idleMinutes === "number" && Number.isFinite(raw.idleMinutes) && raw.idleMinutes > 0
					? raw.idleMinutes
					: DEFAULT_CONFIG.idleMinutes,
			intervalUnit: raw.intervalUnit === "s" || raw.intervalUnit === "h" ? raw.intervalUnit : "m",
			placement: raw.placement === "overlay" ? "overlay" : "widget",
			maxLines: clampInt(raw.maxLines, 1, MAX_BODY_LINES, DEFAULT_CONFIG.maxLines),
			autoShow: typeof raw.autoShow === "boolean" ? raw.autoShow : DEFAULT_CONFIG.autoShow,
			captionLevel: clampInt(raw.captionLevel, BRIGHTNESS_MIN, BRIGHTNESS_MAX, DEFAULT_CONFIG.captionLevel),
			bodyLevel: clampInt(raw.bodyLevel, BRIGHTNESS_MIN, BRIGHTNESS_MAX, DEFAULT_CONFIG.bodyLevel),
		};
	}
	return { ...DEFAULT_CONFIG };
}

function saveConfig(config: Config): void {
	try {
		fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
		fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
	} catch {
		// Persisting is best-effort; the in-memory config still applies.
	}
}

// --- formatting helpers -----------------------------------------------------

function formatAgo(timestamp: number, unit: TimeUnit): string {
	const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
	if (seconds < 1) return "just now";
	// Follow the configured unit for sub-minute values, then escalate.
	if (unit === "s" && seconds < 90) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 1) return "just now";
	if (minutes < 90) return `${minutes} min ago`;
	return `${Math.round(minutes / 60)}h ago`;
}

/** Accepts "30s", "5m", "2h", or a bare number of minutes. */
function parseDuration(input: string): { minutes: number; unit: TimeUnit } | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/i.exec(
		input.trim(),
	);
	if (!match) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return undefined;
	const unit = (match[2] ?? "m").toLowerCase();
	if (unit.startsWith("s")) return { minutes: amount / 60, unit: "s" };
	if (unit.startsWith("h")) return { minutes: amount * 60, unit: "h" };
	return { minutes: amount, unit: "m" };
}

/** 30s / 10m / 2h — the same unit the delay was configured with. */
function formatDelay(minutes: number): string {
	if (minutes < 1) return `${Math.round(minutes * 60)}s`;
	if (minutes < 60) return `${Number.isInteger(minutes) ? minutes : Number(minutes.toFixed(1))}m`;
	const hours = minutes / 60;
	return `${Number.isInteger(hours) ? hours : Number(hours.toFixed(1))}h`;
}

function stripMarkdown(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/(^|\s)[*_]([^*_\s][^*_]*)[*_](?=\s|$)/g, "$1$2")
		.replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "");
}

function collapse(text: string): string {
	return stripMarkdown(text).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

/** Wrap to at most `maxLines`, adding an ellipsis when content is dropped. */
function bodyLines(text: string, width: number, maxLines: number): string[] {
	const wrapped = wrapTextWithAnsi(text, Math.max(4, width));
	if (wrapped.length <= maxLines) return wrapped;
	const kept = wrapped.slice(0, maxLines);
	const last = kept[maxLines - 1] ?? "";
	kept[maxLines - 1] = `${truncateToWidth(last, Math.max(1, width - 1), "")}…`;
	return kept;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string" && text.trim()) parts.push(text);
		}
	}
	return parts.join(" ").trim();
}

// --- session lookup ---------------------------------------------------------

interface LastMessage {
	text: string;
	at: number;
}

function readLastUser(ctx: ExtensionContext): LastMessage | undefined {
	let branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
	try {
		branch = ctx.sessionManager.getBranch();
	} catch {
		return undefined;
	}
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (!entry || entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown } | undefined;
		if (!message || message.role !== "user") continue;
		const text = collapse(extractText(message.content));
		if (!text) continue;
		const at = Date.parse(entry.timestamp);
		return { text, at: Number.isFinite(at) ? at : Date.now() };
	}
	return undefined;
}

// --- rendering --------------------------------------------------------------

function headerText(at: number, unit: TimeUnit): string {
	return `previous message · ${formatAgo(at, unit)}`;
}

/**
 * Plain block: a one-third-width horizontal rule on top, a dim caption, then the text.
 * No box, no background — it should read as a page break, not as a dialog.
 */
function bannerLines(
	theme: Theme,
	width: number,
	text: string,
	at: number,
	maxLines: number,
	unit: TimeUnit,
	captionBrightness: number,
	bodyBrightness: number,
): string[] {
	const safeWidth = Math.max(12, width);
	// One column of inset, matching pi's transcript padding (outputPad: 1).
	const available = Math.max(8, safeWidth - CONTENT_INDENT);
	const contentWidth = Math.min(available, Math.max(MIN_CONTENT_WIDTH, Math.round(available * CONTENT_WIDTH_RATIO)));
	const ruleWidth = Math.max(8, Math.floor(contentWidth / 3));
	const indent = " ".repeat(CONTENT_INDENT);
	// Caption and body hang one space further in than the rule.
	const textIndent = " ".repeat(CONTENT_INDENT + 1);
	const paintCaption = tonePainter(theme, captionBrightness);
	const paintBody = tonePainter(theme, bodyBrightness);
	return [
		indent + paintCaption("─".repeat(ruleWidth)),
		textIndent + paintCaption(truncateToWidth(headerText(at, unit), contentWidth - 1, "…")),
		...bodyLines(text, Math.max(4, contentWidth - 1), maxLines).map((line) => textIndent + paintBody(line)),
	];
}

function widgetComponent(
	theme: Theme,
	text: string,
	at: number,
	maxLines: number,
	unit: TimeUnit,
	captionBrightness: number,
	bodyBrightness: number,
) {
	return {
		render(width: number): string[] {
			return bannerLines(theme, width, text, at, maxLines, unit, captionBrightness, bodyBrightness);
		},
		invalidate() {},
	};
}

// --- extension --------------------------------------------------------------

export default function lastMessageExtension(pi: ExtensionAPI) {
	let config: Config = { ...DEFAULT_CONFIG };
	let activeCtx: ExtensionContext | undefined;
	let lastActivity = Date.now();
	let awaySince: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let shown: Shown;
	let overlayClose: (() => void) | undefined;
	let unbindInput: (() => void) | undefined;

	const idleMs = () => Math.max(1000, Math.round(config.idleMinutes * 60_000));

	function disarm(): void {
		if (!timer) return;
		clearTimeout(timer);
		timer = undefined;
	}

	function hideBanner(ctx: ExtensionContext | undefined): void {
		if (!shown) return;
		try {
			if (shown === "overlay") {
				overlayClose?.();
				overlayClose = undefined;
			} else if (ctx) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
			}
		} catch {
			// The UI may already be torn down (session replacement, shutdown).
		}
		shown = undefined;
	}

	function showBanner(ctx: ExtensionContext): boolean {
		if (!ctx.hasUI || ctx.mode !== "tui") return false;
		const last = readLastUser(ctx);
		if (!last) return false;

		hideBanner(ctx);
		const maxLines = clampInt(config.maxLines, 1, MAX_BODY_LINES, DEFAULT_CONFIG.maxLines);

		if (config.placement === "overlay") {
			overlayClose = undefined;
			const pending = ctx.ui.custom<void>(
				(_tui, theme, _keybindings, done) => {
					overlayClose = () => done(undefined);
					return {
						render: (width: number) =>
							bannerLines(
								theme,
								width,
								last.text,
								last.at,
								maxLines,
								config.intervalUnit,
								config.captionLevel,
								config.bodyLevel,
							),
						invalidate() {},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "top-center",
						width: "72%",
						minWidth: 36,
						maxHeight: Math.min(10, maxLines + 2),
						margin: 1,
						nonCapturing: true,
					},
				},
			);
			// The overlay lives until we call done(); the promise settles then.
			void pending.catch(() => undefined);
			shown = "overlay";
		} else {
			ctx.ui.setWidget(
				WIDGET_KEY,
				(_tui, theme) =>
					widgetComponent(
						theme,
						last.text,
						last.at,
						maxLines,
						config.intervalUnit,
						config.captionLevel,
						config.bodyLevel,
					),
				{ placement: "aboveEditor" },
			);
			shown = "widget";
		}
		return true;
	}

	function refreshBanner(ctx: ExtensionContext): void {
		hideBanner(ctx);
		showBanner(ctx);
	}

	function schedule(): void {
		const ctx = activeCtx;
		if (timer || !ctx || !config.enabled || ctx.mode !== "tui" || !ctx.hasUI) return;
		const wait = Math.max(0, lastActivity + idleMs() - Date.now());
		const handle = setTimeout(tick, wait);
		(handle as unknown as { unref?: () => void }).unref?.();
		timer = handle;
	}

	function tick(): void {
		timer = undefined;
		const ctx = activeCtx;
		if (!ctx) return;
		if (shown) return;
		if (Date.now() - lastActivity < idleMs()) {
			schedule();
			return;
		}
		// Do not interrupt active agent work; agent_settled schedules again.
		if (!ctx.isIdle()) return;
		showBanner(ctx);
	}

	function noteActivity(ctx: ExtensionContext): void {
		activeCtx = ctx;
		lastActivity = Date.now();
		// Typing does not dismiss the reminder; only submitting a prompt does.
		// Keep an armed timer: it fires early, sees the newer timestamp and
		// re-arms for the remainder. That avoids clear/set churn per keystroke.
		if (!timer) schedule();
	}

	function onInputChunk(raw: string): undefined {
		const now = Date.now();
		let data = raw;
		let focusIn = false;

		if (data.includes("\x1b[O")) {
			awaySince = now;
			data = data.split("\x1b[O").join("");
		}
		if (data.includes("\x1b[I")) {
			focusIn = true;
			data = data.split("\x1b[I").join("");
		}

		if (data.length > 0 && activeCtx) noteActivity(activeCtx);

		if (focusIn) {
			const away = awaySince === undefined ? 0 : now - awaySince;
			awaySince = undefined;
			const ctx = activeCtx;
			if (!ctx || ctx.mode !== "tui") return;
			if (shown) {
				refreshBanner(ctx);
			} else if (away >= idleMs() && config.enabled && ctx.isIdle()) {
				showBanner(ctx);
			}
		}
		return undefined;
	}

	pi.on("session_start", (event, ctx) => {
		activeCtx = ctx;
		config = loadConfig();
		lastActivity = Date.now();
		awaySince = undefined;
		disarm();
		shown = undefined;
		overlayClose = undefined;

		if (ctx.mode === "tui" && ctx.hasUI) {
			// resetExtensionUI() drops terminal listeners on session switches,
			// so every session_start re-registers instead of binding once.
			try {
				unbindInput?.();
			} catch {
				// The previous UI may already be gone.
			}
			try {
				unbindInput = ctx.ui.onTerminalInput(onInputChunk);
			} catch {
				unbindInput = undefined;
			}
		}
		schedule();

		// Opening a past session: show the reminder right away instead of
		// waiting for the idle timer. "startup" is a fresh launch, which may
		// still carry history when started with -c / --session.
		const pastSession = event.reason === "resume" || event.reason === "fork" || event.reason === "startup";
		if (config.enabled && config.autoShow && pastSession) showBanner(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		disarm();
		hideBanner(ctx);
		awaySince = undefined;
		try {
			unbindInput?.();
		} catch {
			// Ignore teardown races.
		}
		unbindInput = undefined;
	});

	// --- settings ------------------------------------------------------------

	function applyLines(value: string, ctx: ExtensionContext): void {
		const lines = Number.parseInt(value, 10);
		if (!Number.isFinite(lines) || lines < 1 || lines > MAX_BODY_LINES) {
			ctx.ui.notify(`Usage: /previous-message SetLines <1-${MAX_BODY_LINES}>`, "warning");
			return;
		}
		config.maxLines = lines;
		saveConfig(config);
		if (shown) refreshBanner(ctx);
		ctx.ui.notify(`Showing up to ${lines} body line${lines === 1 ? "" : "s"}`, "info");
	}

	function applyInterval(value: string, ctx: ExtensionContext): void {
		const parsed = parseDuration(value);
		if (!parsed) {
			ctx.ui.notify("Usage: /previous-message SetInterval <30s|5m|2h> (bare number = minutes)", "warning");
			return;
		}
		config.idleMinutes = parsed.minutes;
		config.intervalUnit = parsed.unit;
		saveConfig(config);
		disarm();
		lastActivity = Date.now();
		schedule();
		ctx.ui.notify(`Show the reminder after ${formatDelay(parsed.minutes)} without activity`, "info");
	}

	function applyPlacement(value: string, ctx: ExtensionContext): void {
		if (value !== "widget" && value !== "overlay") {
			ctx.ui.notify("Usage: /previous-message SetPlacement <widget|overlay>", "warning");
			return;
		}
		config.placement = value;
		saveConfig(config);
		hideBanner(ctx);
		ctx.ui.notify(`Placement: ${value}`, "info");
	}

	function applyAutoShow(value: string, ctx: ExtensionContext): void {
		const normalized = value.toLowerCase();
		if (normalized !== "on" && normalized !== "off" && normalized !== "true" && normalized !== "false") {
			ctx.ui.notify("Usage: /previous-message SetAutoShow <on|off>", "warning");
			return;
		}
		config.autoShow = normalized === "on" || normalized === "true";
		saveConfig(config);
		ctx.ui.notify(`Auto-show on session open: ${config.autoShow ? "on" : "off"}`, "info");
	}

	/** /previous-message SetBrightness <caption> <body>, each -5..10. */
	function applyBrightness(value: string, ctx: ExtensionContext): void {
		const parts = value.split(/\s+/).filter(Boolean);
		const caption = Number.parseInt(parts[0] ?? "", 10);
		const body = Number.parseInt(parts[1] ?? "", 10);
		if (
			parts.length !== 2 ||
			!Number.isFinite(caption) ||
			!Number.isFinite(body) ||
			caption < BRIGHTNESS_MIN ||
			caption > BRIGHTNESS_MAX ||
			body < BRIGHTNESS_MIN ||
			body > BRIGHTNESS_MAX
		) {
			ctx.ui.notify("Usage: /previous-message SetBrightness <caption -5..5> <body -5..5>", "warning");
			return;
		}
		config.captionLevel = caption;
		config.bodyLevel = body;
		saveConfig(config);
		if (shown) refreshBanner(ctx);
		ctx.ui.notify(`Brightness: caption ${caption}, body ${body} (-5 background, 0 dim, 2 muted, 5 text)`, "info");
	}

	// The user pressed Enter and submitted a prompt: that is the only input
	// that dismisses the reminder.
	pi.on("input", (_event, ctx) => {
		noteActivity(ctx);
		if (shown) hideBanner(ctx);
	});

	// Agent activity counts as "present": do not count that time as absence.
	const bump = (_event: unknown, ctx: ExtensionContext) => {
		activeCtx = ctx;
		lastActivity = Date.now();
	};
	pi.on("agent_start", bump);
	pi.on("turn_start", bump);
	pi.on("message_end", bump);
	pi.on("tool_execution_end", bump);
	pi.on("agent_settled", (event, ctx) => {
		bump(event, ctx);
		schedule();
	});

	pi.registerCommand("previous-message", {
		description:
			"Previous-message reminder: show | hide | on | off | status | SetLines <1-8> | SetInterval <5m> | SetPlacement <widget|overlay> | SetAutoShow <on|off> | SetBrightness <caption> <body>",
		getArgumentCompletions: (prefix) => {
			const options = [
				"show",
				"hide",
				"on",
				"off",
				"status",
				"SetLines ",
				"SetInterval ",
				"SetPlacement ",
				"SetAutoShow ",
				"SetBrightness ",
			];
			const needle = prefix.toLowerCase();
			const filtered = options.filter((option) => option.toLowerCase().startsWith(needle));
			return filtered.length > 0 ? filtered.map((option) => ({ value: option, label: option })) : null;
		},
		handler: async (args, ctx) => {
			activeCtx = ctx;
			config = loadConfig();
			const [head, ...rest] = args.trim().split(/\s+/);
			const sub = (head ?? "").toLowerCase();
			const value = rest.join(" ").trim();

			switch (sub) {
				case "":
				case "show":
					if (ctx.mode !== "tui") {
						ctx.ui.notify("The reminder is only available in the interactive TUI", "warning");
						return;
					}
					if (!showBanner(ctx)) ctx.ui.notify("No user message found in this session yet", "info");
					return;
				case "hide":
					hideBanner(ctx);
					return;
				case "on":
					config.enabled = true;
					saveConfig(config);
					lastActivity = Date.now();
					schedule();
					ctx.ui.notify(`Reminder enabled (after ${formatDelay(config.idleMinutes)} without activity)`, "info");
					return;
				case "off":
					config.enabled = false;
					saveConfig(config);
					disarm();
					hideBanner(ctx);
					ctx.ui.notify("Reminder disabled", "info");
					return;
				case "status":
					ctx.ui.notify(
						`Previous-message: ${config.enabled ? "on" : "off"} | after ${formatDelay(config.idleMinutes)} ` +
							`| ${config.maxLines} lines | ${config.placement} | auto-show ${config.autoShow ? "on" : "off"} ` +
							`| brightness ${config.captionLevel}/${config.bodyLevel}`,
						"info",
					);
					return;
				case "setlines":
					applyLines(value, ctx);
					return;
				case "setinterval":
					applyInterval(value, ctx);
					return;
				case "setplacement":
					applyPlacement(value, ctx);
					return;
				case "setautoshow":
					applyAutoShow(value, ctx);
					return;
				case "setbrightness":
					applyBrightness(value, ctx);
					return;
				default:
					ctx.ui.notify(
						"Usage: /previous-message <show|hide|on|off|status|SetLines|SetInterval|SetPlacement|SetAutoShow|SetBrightness>",
						"info",
					);
			}
		},
	});
}
