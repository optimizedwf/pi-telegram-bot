import "dotenv/config";
import { Telegraf, Context } from "telegraf";
import { message } from "telegraf/filters";
import {
  createAgentSession,
  getAgentDir,
  SessionManager,
  DefaultResourceLoader,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { isRelayEnabled, relayPost, relayGet, formatGroupContext } from "./relay.js";
import {
  buildSystemPrompt,
  shouldRotateSession,
  summarizeAndRotate,
  readMemory,
} from "./memory.js";
import {
  CHOW_PRIMARY_CHAT_ID,
  addManualBrainNote,
  captureBrainAssistantResult,
  captureBrainUserRequest,
  forceDailyBrainConsolidation,
  formatBrainEventLine,
  getBrainStatus,
  isChowPrimaryChat,
  listBrainEvents,
  maybeRunDailyBrainConsolidation,
  searchBrainEvents,
} from "./chow-brain.js";
import { createChowRuntime, findChowFallbackModel, getChowModelSelection, pinSessionModel, type ChowModelSelection } from "./pi-session.js";
import { createTask, updateTask as updateTaskRecord, listTasks, getOutputPath, readOutput } from "./tasks.js";
import { logChowFeedback } from "./learning-log.js";
import { HiveAgentRuntime, type HiveMessage, type HiveRunTurnInput, type HiveRunTurnResult } from "../../hive/sdk/src/index.js";
import {
  loadJoseSnapshot,
  triageSnapshot,
  buildBrief,
  buildUrgentDigest,
  askFromSnapshot,
  loadJoseTriageState,
  buildTopicsDigestFromState,
  buildTriageState,
} from "./jose-triage.js";
import {
  getMeetManualAction,
  getMeetSidecarRuntimeInfo,
  isMeetSidecarEnabled,
  meetJoin,
  meetLeave,
  meetRecoverCurrentTab,
  meetSetup,
  meetSpeak,
  meetScreenshot,
  meetStatus,
  normalizeMeetUrlOrThrow,
  type MeetMode,
  type MeetTransport,
} from "./meet-sidecar.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_NAME = process.env.BOT_NAME ?? "Bot";

// Bot-to-Bot Communication: known bot peers (user IDs and username patterns)
const KNOWN_BOT_PEERS: Set<number | string> = new Set([
  8290119968, // @Hog_hector_bot
]);
const KNOWN_BOT_PEER_PATTERNS = ["hog_hector", "hector"];

// Anti-loop: track bot-to-bot exchanges per chat
const botToBotTimestamps = new Map<string, number[]>(); // key = chatId, values = timestamps
const BOT_TO_BOT_MAX_PER_MIN = 6; // max bot-to-bot exchanges per chat per minute
const BOT_TO_BOT_MAX_DEPTH = 8; // max back-and-forth before forced silence
const ALLOWED_CHAT_IDS = process.env.ALLOWED_CHAT_IDS
  ? process.env.ALLOWED_CHAT_IDS.split(",").map((s) => s.trim())
  : [];
const HIVE_WS_URL = process.env.HIVE_WS_URL?.trim() || "";
const HIVE_HTTP_URL = (process.env.HIVE_HTTP_URL?.trim() || HIVE_WS_URL.replace(/^ws/i, "http").replace(/\/ws$/, "")).trim();
const HIVE_AGENT_API_KEY = process.env.HIVE_AGENT_API_KEY?.trim() || "";
const HIVE_ENABLED = !!(HIVE_WS_URL && HIVE_AGENT_API_KEY);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim() || "";
const VOICE_PROVIDER = (
  process.env.VOICE_PROVIDER?.trim().toLowerCase() ||
  (GEMINI_API_KEY ? "gemini" : OPENAI_API_KEY ? "openai" : "none")
) as "gemini" | "openai" | "none";

const VOICE_ENABLED =
  (VOICE_PROVIDER === "gemini" && !!GEMINI_API_KEY) ||
  (VOICE_PROVIDER === "openai" && !!OPENAI_API_KEY);

const VOICE_TRANSCRIBE_MODEL =
  process.env.VOICE_TRANSCRIBE_MODEL?.trim() ||
  (VOICE_PROVIDER === "gemini" ? "gemini-2.0-flash" : "gpt-4o-mini-transcribe");
const VOICE_TRANSCRIBE_LANGUAGE = process.env.VOICE_TRANSCRIBE_LANGUAGE?.trim() || "";
const VOICE_REPLY_MODEL =
  process.env.VOICE_REPLY_MODEL?.trim() ||
  (VOICE_PROVIDER === "gemini" ? "gemini-2.5-flash-preview-tts" : "gpt-4o-mini-tts");
const VOICE_REPLY_VOICE = process.env.VOICE_REPLY_VOICE?.trim() || (VOICE_PROVIDER === "gemini" ? "Kore" : "alloy");
const VOICE_REPLY_FORMAT = (process.env.VOICE_REPLY_FORMAT?.trim() || "opus").toLowerCase();
const VOICE_REPLY_DEFAULT = (process.env.VOICE_REPLY_DEFAULT?.trim() || "off").toLowerCase();

if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required in .env");
const chowModelSelection = getChowModelSelection();
console.log(
  `🤖 Bot name: ${BOT_NAME} | Relay: ${isRelayEnabled() ? process.env.RELAY_URL : "disabled"} | Hive: ${HIVE_ENABLED ? HIVE_WS_URL : "disabled"} | Voice: ${VOICE_ENABLED ? `enabled(${VOICE_PROVIDER})` : "disabled"} | Model: ${chowModelSelection.provider}/${chowModelSelection.modelId}`
);

const SESSIONS_DIR = path.join(process.cwd(), "sessions");
const MEDIA_CACHE_DIR = process.env.MEDIA_CACHE_DIR?.trim() || path.join(process.cwd(), "media-cache");
const TG_MAX_LENGTH = 4000; // leave headroom under 4096
const EDIT_INTERVAL_MS = 1500; // how often to edit streaming message
const STUCK_TIMEOUT_MS = Number(process.env.STUCK_TIMEOUT_MS ?? 0); // 0 disables auto-timeout
const TELEGRAM_RETRY_ATTEMPTS = Number(process.env.TELEGRAM_RETRY_ATTEMPTS ?? 3);
const TELEGRAM_RETRY_BASE_MS = Number(process.env.TELEGRAM_RETRY_BASE_MS ?? 450);
const GROUP_RESPONSE_MODE = (process.env.GROUP_RESPONSE_MODE?.trim().toLowerCase() || "mention") as "mention" | "all";
const GROUP_RESPOND_WITHOUT_TAG = GROUP_RESPONSE_MODE === "all";
const CHOW_BRAIN_DAILY_TICK_MS = Number(process.env.CHOW_BRAIN_DAILY_TICK_MS ?? 60 * 60 * 1000);
const CHOW_AUTH_ROTATION_ENABLED = String(process.env.CHOW_AUTH_ROTATION_ENABLED ?? "1").trim() !== "0";
const CHOW_AUTH_ROTATION_MAX_ATTEMPTS = Math.max(0, Number(process.env.CHOW_AUTH_ROTATION_MAX_ATTEMPTS ?? 2));
const CHOW_AUTH_ROTATION_SCRIPT = path.join(process.cwd(), "scripts", "chow_auth_rotation.py");
const AUTO_COMPACT_ENABLED = String(process.env.AUTO_COMPACT_ENABLED ?? "1").trim() !== "0";
const AUTO_COMPACT_CONTEXT_RATIO = Math.min(0.95, Math.max(0.05, Number(process.env.AUTO_COMPACT_CONTEXT_RATIO ?? 0.65)));
const AUTO_COMPACT_MIN_TOKENS = Math.max(0, Number(process.env.AUTO_COMPACT_MIN_TOKENS ?? 24_000));
const CONTEXT_CHARS_PER_TOKEN = Math.max(1, Number(process.env.CONTEXT_CHARS_PER_TOKEN ?? 4));
const MATERIALS_REGISTRY_PATH = path.join(process.cwd(), "learning-center", "data", "agent-build-materials.json");
const BOOKING_CONFIG_PATH = path.join(process.cwd(), "data", "booking-config.json");
const CAL_DIY_PROVIDER_NAME = process.env.CAL_DIY_PROVIDER_NAME?.trim() || "cal.diy";
const CAL_DIY_BOOKING_URL = process.env.CAL_DIY_BOOKING_URL?.trim() || "";
const MEET_CHAT_STATE_PATH = path.join(process.cwd(), "data", "meet-chat-state.json");

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
fs.mkdirSync(path.dirname(BOOKING_CONFIG_PATH), { recursive: true });
fs.mkdirSync(path.dirname(MEET_CHAT_STATE_PATH), { recursive: true });

// ─── Session management ───────────────────────────────────────────────────────

type ChannelId = string | number;

interface ChatState {
  session: AgentSession;
  busy: boolean;
  abortController?: AbortController;
}

const chatStates = new Map<string, ChatState>();
const voiceReplyPrefs = new Map<string, boolean>();

interface MeetChatState {
  sessionId?: string;
  meetingUrl?: string;
  transport?: MeetTransport;
  mode?: MeetMode;
  updatedAt: string;
}

function loadMeetChatState(): Record<string, MeetChatState> {
  try {
    const raw = fs.readFileSync(MEET_CHAT_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, MeetChatState>;
    }
  } catch {
    // ignore missing/invalid file
  }
  return {};
}

const meetChatState: Record<string, MeetChatState> = loadMeetChatState();

function saveMeetChatState(): void {
  try {
    fs.writeFileSync(MEET_CHAT_STATE_PATH, JSON.stringify(meetChatState, null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn(`[meet] failed to persist chat state: ${(err as any)?.message ?? err}`);
  }
}

function setMeetChatState(chatId: ChannelId, patch: Partial<MeetChatState>): void {
  const key = sessionKey(chatId);
  const current = meetChatState[key] ?? { updatedAt: new Date().toISOString() };
  meetChatState[key] = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  saveMeetChatState();
}

function clearMeetChatState(chatId: ChannelId): void {
  const key = sessionKey(chatId);
  if (!meetChatState[key]) return;
  delete meetChatState[key];
  saveMeetChatState();
}

function getMeetChatState(chatId: ChannelId): MeetChatState | undefined {
  return meetChatState[sessionKey(chatId)];
}

let hiveRuntime: HiveAgentRuntime | null = null;

function sessionKey(channelId: ChannelId): string {
  return String(channelId);
}

type ContextEstimate = {
  chars: number;
  approxTokens: number;
  contextWindow: number;
  ratio: number;
  pct: number;
};

function estimateContentChars(value: any, depth = 0): number {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (depth > 8) {
    try { return JSON.stringify(value)?.length ?? 0; } catch { return 0; }
  }
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateContentChars(item, depth + 1), 0);
  if (typeof value === "object") {
    let total = 0;
    for (const key of ["text", "thinking", "content", "toolName", "errorMessage", "stopReason"]) {
      if (key in value) total += estimateContentChars(value[key], depth + 1);
    }
    if (total > 0) return total;
    return Object.values(value).reduce((sum, item) => sum + estimateContentChars(item, depth + 1), 0);
  }
  return 0;
}

function getModelContextWindowTokens(session: AgentSession): number {
  const model = session.model as any;
  const provider = String(model?.provider ?? "");
  const id = String(model?.id ?? "");
  const fromModel = Number(model?.contextWindow ?? model?.context_window ?? model?.contextLength ?? model?.maxInputTokens ?? 0);
  if (Number.isFinite(fromModel) && fromModel > 0) return fromModel;
  if (provider === "ollama" && id.includes("deepseek-v4")) return 1_048_576;
  if (provider === "ollama" && (id.includes("qwen3.6") || id.includes("qwen3.5") || id.includes("kimi"))) return 262_144;
  if (provider === "ollama" && id.includes("gpt-oss")) return 131_072;
  return 128_000;
}

function estimateSessionContext(session: AgentSession, extraText = ""): ContextEstimate {
  const messageChars = estimateContentChars((session as any).messages ?? []);
  const chars = messageChars + extraText.length;
  const approxTokens = Math.ceil(chars / CONTEXT_CHARS_PER_TOKEN);
  const contextWindow = getModelContextWindowTokens(session);
  const ratio = contextWindow > 0 ? approxTokens / contextWindow : 0;
  return { chars, approxTokens, contextWindow, ratio, pct: Math.round(ratio * 1000) / 10 };
}

function formatContextEstimate(estimate: ContextEstimate): string {
  return `${estimate.approxTokens.toLocaleString()}/${estimate.contextWindow.toLocaleString()} tok ≈ ${estimate.pct}%`;
}

async function maybeAutoCompactSession(
  chatId: ChannelId,
  state: ChatState,
  upcomingPrompt = "",
  notify?: (text: string) => Promise<void>
): Promise<ContextEstimate> {
  let estimate = estimateSessionContext(state.session, upcomingPrompt);
  if (!AUTO_COMPACT_ENABLED) return estimate;
  const shouldCompact =
    estimate.approxTokens >= AUTO_COMPACT_MIN_TOKENS &&
    estimate.ratio >= AUTO_COMPACT_CONTEXT_RATIO &&
    ((state.session as any).messages?.length ?? 0) > 4;
  if (!shouldCompact) return estimate;
  const beforeMessages = ((state.session as any).messages?.length ?? 0);
  console.warn(`[auto-compact] chat=${sessionKey(chatId)} context=${formatContextEstimate(estimate)} threshold=${Math.round(AUTO_COMPACT_CONTEXT_RATIO * 100)}% messages=${beforeMessages}`);
  if (notify) await notify(`🗜️ Context is at ${formatContextEstimate(estimate)}. Auto-compacting before I answer...`).catch(() => {});
  try {
    await state.session.compact();
    estimate = estimateSessionContext(state.session, upcomingPrompt);
    const afterMessages = ((state.session as any).messages?.length ?? 0);
    console.log(`[auto-compact] chat=${sessionKey(chatId)} done messages=${beforeMessages}->${afterMessages} context=${formatContextEstimate(estimate)}`);
    if (notify) await notify(`✅ Compacted: ${beforeMessages}→${afterMessages} messages, now ${formatContextEstimate(estimate)}.`).catch(() => {});
  } catch (err: any) {
    console.error(`[auto-compact] chat=${sessionKey(chatId)} failed:`, err?.message ?? err);
    if (notify) await notify(`⚠️ Auto-compaction failed: ${String(err?.message ?? err).slice(0, 220)}. I’ll try to continue.`).catch(() => {});
  }
  return estimateSessionContext(state.session, upcomingPrompt);
}

function getSessionDir(chatId: ChannelId): string {
  const dir = path.join(SESSIONS_DIR, sessionKey(chatId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getMediaCacheDir(chatId: ChannelId): string {
  const dir = path.join(MEDIA_CACHE_DIR, sessionKey(chatId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runChowAuthRotation(args: string[]): any | null {
  if (!CHOW_AUTH_ROTATION_ENABLED || !fs.existsSync(CHOW_AUTH_ROTATION_SCRIPT)) return null;
  const result = spawnSync("python3", [CHOW_AUTH_ROTATION_SCRIPT, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.warn(`[AUTH_ROTATION] failed args=${args.join(" ")} err=${(result.stderr || result.stdout || "").trim()}`);
    return null;
  }
  try {
    return JSON.parse(String(result.stdout || "{}"));
  } catch {
    console.warn(`[AUTH_ROTATION] non-json output args=${args.join(" ")} out=${String(result.stdout || "").trim()}`);
    return null;
  }
}

function markCurrentAuthResult(result: "success" | "failure", reason: string): void {
  runChowAuthRotation(["mark-current", "--result", result, "--reason", reason]);
}

function rotateToNextAuthProfile(): any | null {
  return runChowAuthRotation(["rotate-next"]);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "file";
}

async function cacheTelegramFile(
  ctx: Context,
  chatId: ChannelId,
  fileId: string,
  preferredName: string
): Promise<{ localPath: string; mimeType: string; size: number }> {
  const fileUrl = await withTelegramRetries("getFileLink(media)", async () => {
    const link = await ctx.telegram.getFileLink(fileId);
    return String(link);
  });

  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file (${response.status})`);
  }

  const arr = await response.arrayBuffer();
  const buf = Buffer.from(arr);
  const mimeType = String(response.headers.get("content-type") || "application/octet-stream");
  const safeName = sanitizeFilename(preferredName);
  const uniquePrefix = `${Date.now()}-${randomUUID().slice(0, 8)}-${fileId.slice(-10)}`;
  const localPath = path.join(getMediaCacheDir(chatId), `${uniquePrefix}-${safeName}`);
  fs.writeFileSync(localPath, buf);

  return { localPath, mimeType, size: buf.length };
}

async function getOrCreateSession(chatId: ChannelId, modelOverride?: ChowModelSelection): Promise<AgentSession> {
  const key = sessionKey(chatId);
  const existing = chatStates.get(key);
  if (existing) return existing.session;

  // Auto-rotate if session is too large — summarize into memory first
  if (shouldRotateSession(key)) {
    console.log(`[session] Auto-rotating session for channel ${key}`);
    await summarizeAndRotate(key, BOT_NAME);
  }

  const { authStorage, modelRegistry, settingsManager, model } = createChowRuntime(modelOverride);
  const sessionDir = getSessionDir(key);

  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir,
    settingsManager,
    systemPromptOverride: () => buildSystemPrompt(key, BOT_NAME),
  });
  await loader.reload();

  const { session } = await createAgentSession({
    sessionManager: SessionManager.continueRecent(process.cwd(), sessionDir),
    authStorage,
    modelRegistry,
    settingsManager,
    model,
    resourceLoader: loader,
  });
  await pinSessionModel(session, model);

  chatStates.set(key, { session, busy: false });
  return session;
}

async function resetSession(chatId: ChannelId, summarize = true): Promise<AgentSession> {
  return resetSessionWithModel(chatId, summarize);
}

async function resetSessionWithModel(
  chatId: ChannelId,
  summarize = true,
  modelOverride?: ChowModelSelection
): Promise<AgentSession> {
  const key = sessionKey(chatId);
  const existing = chatStates.get(key);
  if (existing) {
    existing.session.dispose();
    chatStates.delete(key);
  }

  if (summarize) {
    await summarizeAndRotate(key, BOT_NAME);
  }

  const { authStorage, modelRegistry, settingsManager, model } = createChowRuntime(modelOverride);
  const sessionDir = getSessionDir(key);

  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir,
    settingsManager,
    systemPromptOverride: () => buildSystemPrompt(key, BOT_NAME),
  });
  await loader.reload();

  const { session } = await createAgentSession({
    sessionManager: SessionManager.create(process.cwd(), sessionDir),
    authStorage,
    modelRegistry,
    settingsManager,
    model,
    resourceLoader: loader,
  });
  await pinSessionModel(session, model);

  chatStates.set(key, { session, busy: false });
  return session;
}

async function resetSessionToFallbackModel(
  chatId: ChannelId,
  excludeKeys: string[] = []
): Promise<{ session: AgentSession; selection: ChowModelSelection } | null> {
  const fallback = findChowFallbackModel(excludeKeys);
  if (!fallback) return null;
  const session = await resetSessionWithModel(chatId, false, fallback.selection);
  return { session, selection: fallback.selection };
}

async function tryFallbackChain(
  chatId: ChannelId,
  attemptedKeys: string[],
  onSwitch: (selection: ChowModelSelection) => Promise<void>,
  subscribeToSession: (activeSession: AgentSession) => () => void,
  runPromptAttempt: (activeSession: AgentSession, promptText: string, streamingBehavior?: "steer" | "followUp") => Promise<string>,
  promptText: string
): Promise<{ finalText: string; session: AgentSession | null; unsub: (() => void) | null; attemptedKeys: string[] }> {
  let session: AgentSession | null = null;
  let unsub: (() => void) | null = null;
  let finalText = "";

  while (true) {
    const fallback = await resetSessionToFallbackModel(chatId, attemptedKeys);
    if (!fallback) {
      break;
    }

    const fallbackKey = `${fallback.selection.provider}/${fallback.selection.modelId}`;
    attemptedKeys.push(fallbackKey);
    console.warn(`[EMPTY_RESPONSE] chatId=${chatId} — switching to fallback model ${fallbackKey}`);
    await onSwitch(fallback.selection);

    session = fallback.session;
    unsub = subscribeToSession(session);
    finalText = await runPromptAttempt(session, promptText, "steer");
    if (finalText) {
      return { finalText, session, unsub, attemptedKeys };
    }

    if (unsub) {
      unsub();
      unsub = null;
    }
  }

  return { finalText, session, unsub, attemptedKeys };
}

// ─── Telegram helpers ─────────────────────────────────────────────────────────

function escapeMarkdown(text: string): string {
  // Escape special Markdown V2 chars
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

function truncate(text: string, max = TG_MAX_LENGTH): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

function getTelegramErrorCode(err: any): string {
  return String(err?.code ?? err?.errno ?? err?.response?.error_code ?? "").toUpperCase();
}

function isRetryableTelegramError(err: any): boolean {
  const code = getTelegramErrorCode(err);
  const message = String(err?.message ?? "").toLowerCase();

  if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "EAI_AGAIN" || code === "ECONNREFUSED") {
    return true;
  }

  if (code === "429" || code === "500" || code === "502" || code === "503" || code === "504") {
    return true;
  }

  return message.includes("timeout") || message.includes("temporarily unavailable") || message.includes("too many requests");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTelegramRetries<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  let lastErr: any;

  while (attempt < TELEGRAM_RETRY_ATTEMPTS) {
    attempt += 1;
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (!isRetryableTelegramError(err) || attempt >= TELEGRAM_RETRY_ATTEMPTS) {
        throw err;
      }
      const delayMs = TELEGRAM_RETRY_BASE_MS * 2 ** (attempt - 1);
      console.warn(`[telegram-retry] ${label} failed attempt ${attempt}/${TELEGRAM_RETRY_ATTEMPTS}; retrying in ${delayMs}ms:`, err?.message ?? err);
      await sleep(delayMs);
    }
  }

  throw lastErr;
}

async function safeSend(ctx: Context, text: string): Promise<any> {
  const chunks = splitMessage(text);
  let last: any;

  for (const chunk of chunks) {
    const sanitized = chunk.replace(/[<>&]/g, "");
    last = await withTelegramRetries("reply", async () => {
      try {
        return await ctx.reply(chunk, { parse_mode: undefined });
      } catch {
        return await ctx.reply(sanitized, { parse_mode: undefined });
      }
    });
  }

  return last;
}

async function safeEdit(ctx: Context, msgId: number, text: string): Promise<void> {
  const chunks = splitMessage(text);
  const nextText = truncate(chunks[0] || "");

  await withTelegramRetries(`editMessageText:${msgId}`, async () => {
    try {
      await ctx.telegram.editMessageText(ctx.chat!.id, msgId, undefined, nextText);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg.includes("message is not modified")) return;
      if (msg.includes("message to edit not found")) {
        console.warn(`[edit] Message ${msgId} not found, likely deleted.`);
        return;
      }
      throw err;
    }
  });
}

function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TG_MAX_LENGTH) {
    // Split at last newline before limit
    let idx = remaining.lastIndexOf("\n", TG_MAX_LENGTH);
    if (idx < 0) idx = TG_MAX_LENGTH;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function normalizeMeetTransportInput(value: unknown): MeetTransport | undefined {
  const lower = String(value ?? "").trim().toLowerCase();
  if (lower === "chrome" || lower === "chrome-node" || lower === "twilio") return lower;
  return undefined;
}

function normalizeMeetModeInput(value: unknown): MeetMode | undefined {
  const lower = String(value ?? "").trim().toLowerCase();
  if (lower === "realtime" || lower === "transcribe") return lower;
  return undefined;
}

function parseMeetFlag(raw: string, flag: string): { value?: string; rest: string } {
  const rx = new RegExp(`(?:^|\\s)${flag}\\s+("([^"]+)"|'([^']+)'|(\\S+))`, "i");
  const match = raw.match(rx);
  if (!match) return { rest: raw.trim() };
  const value = match[2] ?? match[3] ?? match[4] ?? "";
  const rest = `${raw.slice(0, match.index ?? 0)} ${raw.slice((match.index ?? 0) + match[0].length)}`.replace(/\s+/g, " ").trim();
  return { value: value.trim(), rest };
}

function formatMeetSetupSummary(payload: any): string {
  if (!payload || typeof payload !== "object") return "Setup returned no data.";
  const checks = Array.isArray(payload.checks) ? payload.checks : [];
  const lines = [
    `🧪 Meet setup: ${payload.ok ? "OK" : "needs attention"}`,
    ...checks.slice(0, 12).map((check: any) => `${check?.ok ? "✅" : "⚠️"} ${check?.id || "check"} — ${check?.message || "(no message)"}`),
  ];
  return lines.join("\n");
}

function getMeetSessionsFromStatus(payload: any): any[] {
  if (!payload || typeof payload !== "object") return [];
  if (payload.session) return [payload.session];
  if (Array.isArray(payload.sessions)) return payload.sessions;
  return [];
}

function formatMeetStatusSummary(payload: any): string {
  const sessions = getMeetSessionsFromStatus(payload);
  if (!sessions.length) {
    if (payload?.found === false) return "No active Meet session found.";
    return "No active Meet sessions.";
  }

  const lines: string[] = [];
  for (const session of sessions.slice(0, 3)) {
    const health = session?.chrome?.health ?? {};
    lines.push(
      [
        `🎥 ${session?.id || "unknown"} (${session?.state || "unknown"})`,
        `URL: ${session?.url || "n/a"}`,
        `Transport: ${session?.transport || "n/a"} | Mode: ${session?.mode || "n/a"}`,
        `In-call: ${health?.inCall === true ? "yes" : health?.inCall === false ? "no" : "unknown"}`,
        `Realtime: ${health?.realtimeReady === true ? "ready" : health?.providerConnected === true ? "connected" : "not-ready"}`,
        health?.manualActionRequired
          ? `⚠️ Manual action (${health?.manualActionReason || "required"}): ${health?.manualActionMessage || "Check meeting tab permissions/login/admission."}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return lines.join("\n\n");
}

function formatMeetRecoverSummary(payload: any): string {
  if (!payload || typeof payload !== "object") return "Recover returned no data.";
  const browser = payload.browser || {};
  const lines = [
    "🩺 Meet recover result",
    `manualActionRequired: ${payload.manualActionRequired ? "yes" : "no"}`,
    payload.manualActionRequired ? `reason: ${payload.manualActionReason || "unknown"}` : "",
    payload.manualActionMessage ? `message: ${payload.manualActionMessage}` : "",
    browser?.nodeId ? `node: ${browser.nodeId}` : "",
    browser?.targetId ? `target: ${browser.targetId}` : "",
    browser?.browserUrl ? `tab: ${browser.browserUrl}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

function isVoiceReplyPreferred(chatId: number): boolean {
  const key = sessionKey(chatId);
  const fromMap = voiceReplyPrefs.get(key);
  if (typeof fromMap === "boolean") return fromMap;
  return ["1", "true", "on", "yes"].includes(VOICE_REPLY_DEFAULT);
}

function setVoiceReplyPreferred(chatId: number, enabled: boolean): void {
  voiceReplyPrefs.set(sessionKey(chatId), enabled);
}

function extractGeminiText(json: any): string {
  const candidates = Array.isArray(json?.candidates) ? json.candidates : [];
  const parts = candidates[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part: any) => String(part?.text ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extFromMimeType(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes("ogg")) return "ogg";
  if (lower.includes("wav")) return "wav";
  if (lower.includes("mpeg") || lower.includes("mp3")) return "mp3";
  if (lower.includes("opus")) return "ogg";
  return "bin";
}

function parsePcmRateFromMimeType(mimeType: string): number {
  const match = /rate=(\d+)/i.exec(mimeType);
  const parsed = Number(match?.[1] ?? "24000");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24000;
}

function pcm16LeToWav(pcmBuffer: Buffer, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmBuffer.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

function transcodeWavToOpusOgg(wavBuffer: Buffer): Buffer | null {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chow-tts-"));
  const inPath = path.join(tmpDir, "in.wav");
  const outPath = path.join(tmpDir, "out.ogg");

  try {
    fs.writeFileSync(inPath, wavBuffer);
    const ffmpegResult = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inPath,
        "-c:a",
        "libopus",
        "-b:a",
        "32k",
        "-vbr",
        "on",
        "-application",
        "voip",
        outPath,
      ],
      { encoding: "utf8" }
    );

    if (ffmpegResult.status !== 0 || !fs.existsSync(outPath)) {
      const err = (ffmpegResult.stderr || ffmpegResult.stdout || "ffmpeg failed").slice(0, 220);
      console.warn(`[voice-reply] ffmpeg transcode failed: ${err}`);
      return null;
    }

    return fs.readFileSync(outPath);
  } catch (err: any) {
    console.warn(`[voice-reply] ffmpeg transcode error: ${err?.message ?? err}`);
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup issues
    }
  }
}

function shouldSendAsVoiceNote(audio: { mimeType: string; filename: string }): boolean {
  const mime = audio.mimeType.toLowerCase();
  const file = audio.filename.toLowerCase();
  return mime.includes("ogg") || mime.includes("opus") || file.endsWith(".ogg");
}

async function sendSynthesizedAudio(ctx: Context, audio: { buffer: Buffer; filename: string; mimeType: string }): Promise<void> {
  if (shouldSendAsVoiceNote(audio)) {
    try {
      await ctx.replyWithVoice({ source: audio.buffer, filename: audio.filename });
      return;
    } catch {
      await ctx.replyWithAudio({ source: audio.buffer, filename: audio.filename });
      return;
    }
  }

  try {
    await ctx.replyWithAudio({ source: audio.buffer, filename: audio.filename });
  } catch {
    await ctx.replyWithVoice({ source: audio.buffer, filename: audio.filename });
  }
}

async function synthesizeVoiceReply(text: string): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
  if (!VOICE_ENABLED) {
    throw new Error("Voice is not configured. Set GEMINI_API_KEY or OPENAI_API_KEY.");
  }

  const safeInput = text.replace(/[`*_\[\]()~>#+\-=|{}.!\\]/g, "").trim().slice(0, 1400);
  if (!safeInput) throw new Error("No text to synthesize");

  if (VOICE_PROVIDER === "gemini") {
    const prompt = `Read this naturally and clearly. Keep pacing conversational.\n\n${safeInput}`;
    const body: any = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: VOICE_REPLY_VOICE,
            },
          },
        },
      },
    };

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(VOICE_REPLY_MODEL)}:generateContent?key=${GEMINI_API_KEY}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Gemini TTS failed (${response.status}): ${errText.slice(0, 200)}`);
    }

    const json = await response.json().catch(() => ({}));
    const parts = json?.candidates?.[0]?.content?.parts;
    const audioPart = Array.isArray(parts)
      ? parts.find((p: any) => p?.inlineData?.data || p?.inline_data?.data)
      : null;

    const inlineData = audioPart?.inlineData ?? audioPart?.inline_data;
    const data = String(inlineData?.data ?? "");
    let mimeType = String(inlineData?.mimeType ?? inlineData?.mime_type ?? "audio/wav");

    if (!data) {
      throw new Error("Gemini TTS returned no audio data.");
    }

    let buffer = Buffer.from(data, "base64");

    // Gemini TTS often returns raw PCM (`audio/L16;codec=pcm;rate=24000`).
    // Wrap to WAV first, then transcode to OGG/Opus so Telegram voice notes carry proper duration.
    if (/audio\/l16|pcm/i.test(mimeType)) {
      const sampleRate = parsePcmRateFromMimeType(mimeType);
      buffer = pcm16LeToWav(buffer, sampleRate, 1, 16);
      mimeType = "audio/wav";
    }

    if (mimeType.toLowerCase().includes("wav")) {
      const opusBuffer = transcodeWavToOpusOgg(buffer);
      if (opusBuffer && opusBuffer.length > 0) {
        return {
          buffer: opusBuffer,
          filename: "reply.ogg",
          mimeType: "audio/ogg",
        };
      }
    }

    const ext = extFromMimeType(mimeType);
    return {
      buffer,
      filename: `reply.${ext}`,
      mimeType,
    };
  }

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: VOICE_REPLY_MODEL,
      voice: VOICE_REPLY_VOICE,
      input: safeInput,
      response_format: VOICE_REPLY_FORMAT,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`OpenAI TTS request failed (${response.status}): ${errText.slice(0, 180)}`);
  }

  const arr = await response.arrayBuffer();
  const ext = VOICE_REPLY_FORMAT === "opus" ? "ogg" : VOICE_REPLY_FORMAT;
  const mimeType = VOICE_REPLY_FORMAT === "opus" ? "audio/ogg" : `audio/${ext}`;
  return {
    buffer: Buffer.from(arr),
    filename: `reply.${ext}`,
    mimeType,
  };
}

async function maybeSendVoiceReply(ctx: Context, chatId: number, text: string): Promise<void> {
  if (!isVoiceReplyPreferred(chatId)) return;
  if (!VOICE_ENABLED) return;

  try {
    const audio = await synthesizeVoiceReply(text);
    await withTelegramRetries("replyWithVoice", async () => {
      await sendSynthesizedAudio(ctx, audio);
    });
  } catch (err: any) {
    console.warn(`[voice-reply] failed for chat ${chatId}:`, err?.message ?? err);
  }
}

async function transcribeTelegramAudio(
  ctx: Context,
  fileId: string,
  fileName = "audio.ogg",
  mimeType = "audio/ogg"
): Promise<string> {
  if (!VOICE_ENABLED) {
    throw new Error("Voice transcription is not configured. Set GEMINI_API_KEY or OPENAI_API_KEY.");
  }

  const fileUrl = await withTelegramRetries("getFileLink", async () => {
    const link = await ctx.telegram.getFileLink(fileId);
    return String(link);
  });

  const fileResponse = await fetch(fileUrl);
  if (!fileResponse.ok) {
    throw new Error(`Failed to download Telegram audio (${fileResponse.status})`);
  }

  const fileBuffer = await fileResponse.arrayBuffer();

  if (VOICE_PROVIDER === "gemini") {
    const audioBase64 = Buffer.from(fileBuffer).toString("base64");
    const prompt = [
      "Transcribe this audio exactly.",
      "Output only plain text transcript.",
      "No timestamps, no speaker labels, no commentary.",
      VOICE_TRANSCRIBE_LANGUAGE ? `Language hint: ${VOICE_TRANSCRIBE_LANGUAGE}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const body = {
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: mimeType,
                data: audioBase64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
      },
    };

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(VOICE_TRANSCRIBE_MODEL)}:generateContent?key=${GEMINI_API_KEY}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Gemini transcription failed (${response.status}): ${errText.slice(0, 220)}`);
    }

    const json = await response.json().catch(() => ({}));
    const text = extractGeminiText(json);
    if (!text) {
      throw new Error("Gemini transcription came back empty.");
    }
    return text;
  }

  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: mimeType }), fileName);
  form.append("model", VOICE_TRANSCRIBE_MODEL);
  if (VOICE_TRANSCRIBE_LANGUAGE) {
    form.append("language", VOICE_TRANSCRIBE_LANGUAGE);
  }

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: form,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`OpenAI transcription request failed (${response.status}): ${errText.slice(0, 200)}`);
  }

  const json = await response.json().catch(() => ({}));
  const text = String(json?.text ?? "").trim();
  if (!text) {
    throw new Error("Transcription came back empty.");
  }

  return text;
}

function isAllowed(chatId: number): boolean {
  if (ALLOWED_CHAT_IDS.length === 0) return true; // open if no allowlist
  return ALLOWED_CHAT_IDS.includes(String(chatId));
}

function getJoseSnapshotPath(): string {
  return process.env.JOSE_TG_SNAPSHOT_PATH || "/home/ubuntu/pi-telegram-bot/data/jose-telegram-snapshot.json";
}

function getJoseTriageStatePath(): string {
  return process.env.JOSE_TG_TRIAGE_STATE_PATH || "/home/ubuntu/pi-telegram-bot/data/jose-telegram-triage-state.json";
}

function getJoseEventsPath(): string {
  return process.env.JOSE_TG_EVENTS_PATH || "/home/ubuntu/pi-telegram-bot/data/jose-telegram-events.ndjson";
}

function loadJoseSnapshotContext(): string {
  if (BOT_NAME.toLowerCase() !== "jose") return "";

  const snapshot = loadJoseSnapshot(getJoseSnapshotPath());
  if (!snapshot) return "";

  const triaged = triageSnapshot(snapshot);
  const state = loadJoseTriageState(getJoseTriageStatePath()) ?? buildTriageState(snapshot, triaged);

  if (state.loadMode === "flood") {
    return [
      `--- JOSE HIGH-LOAD CONTEXT (${state.loadMode}) ---`,
      `Generated: ${state.generatedAt} | unreadDialogs=${state.totals.unreadDialogs} | urgentItems=${state.totals.urgentItems}`,
      "Use urgent queue only; avoid broad summaries and ask clarifying follow-up when uncertain.",
      buildUrgentDigest(triaged, 8),
      "--- END JOSE HIGH-LOAD CONTEXT ---",
    ].join("\n");
  }

  return `${buildBrief(triaged, snapshot.generatedAt)}\nLoad mode: ${state.loadMode} (${state.loadReasons.join(", ")})`;
}

function getJoseRecentEventsText(limit = 20): string {
  if (BOT_NAME.toLowerCase() !== "jose") {
    return "This command is only available on Jose runtime.";
  }

  const eventsPath = getJoseEventsPath();
  if (!fs.existsSync(eventsPath)) {
    return "No event log available yet. Wait for jose-ingest cycle.";
  }

  const lines = fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
  const rows = lines.slice(-limit).map((line) => {
    try {
      return JSON.parse(line) as any;
    } catch {
      return null;
    }
  }).filter(Boolean);

  if (!rows.length) return "No recent events found.";

  return [
    `Recent delta events (${rows.length}):`,
    ...rows.map((row: any, idx: number) => {
      if (row.type === "unread_delta") {
        return `${idx + 1}. ${row.title} | delta=${row.delta} (${row.unreadBefore}->${row.unreadAfter}) | dialog:${row.dialogId}`;
      }
      return `${idx + 1}. ${row.type} ${row.title} unread=${row.unreadCount ?? "?"} | dialog:${row.dialogId}`;
    }),
  ].join("\n");
}

function getJoseTriageText(kind: "brief" | "urgent" | "ask" | "topics", query?: string): string {
  if (BOT_NAME.toLowerCase() !== "jose") {
    return "This command is only available on Jose runtime.";
  }

  const triageState = loadJoseTriageState(getJoseTriageStatePath());
  const snapshot = loadJoseSnapshot(getJoseSnapshotPath());

  if (!snapshot && !triageState) {
    return "No Telegram snapshot found yet. Wait for jose-ingest to update and retry.";
  }

  const triaged = snapshot ? triageSnapshot(snapshot) : [];
  const effectiveState = triageState ?? (snapshot ? buildTriageState(snapshot, triaged) : null);

  if (kind === "topics") {
    if (!effectiveState) return "No topic lanes available yet.";
    return buildTopicsDigestFromState(effectiveState);
  }

  if (kind === "brief") {
    const brief = buildBrief(triaged, snapshot?.generatedAt);
    if (!effectiveState) return brief;
    return `${brief}\nLoad mode: ${effectiveState.loadMode} (${effectiveState.loadReasons.join(", ")})`;
  }

  if (kind === "urgent") {
    const header = effectiveState
      ? `Urgent queue from snapshot ${effectiveState.generatedAt}: mode=${effectiveState.loadMode}`
      : `Urgent queue from snapshot ${snapshot?.generatedAt || "unknown"}:`;
    return [header, buildUrgentDigest(triaged)].join("\n\n");
  }

  return askFromSnapshot(triaged, query || "");
}

type BookingConfig = {
  provider?: string;
  booking_url?: string;
  updated_at?: string;
  notes?: string;
};

type ActiveBookingConfig = {
  provider: string;
  bookingUrl: string;
  source: "env" | "file" | "none";
  updatedAt?: string;
};

function normalizeBookingUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

function loadBookingConfig(): BookingConfig {
  try {
    if (!fs.existsSync(BOOKING_CONFIG_PATH)) return {};
    const raw = fs.readFileSync(BOOKING_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as BookingConfig;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveBookingConfig(config: BookingConfig): void {
  const nextConfig: BookingConfig = {
    provider: (config.provider || CAL_DIY_PROVIDER_NAME).trim() || CAL_DIY_PROVIDER_NAME,
    booking_url: (config.booking_url || "").trim(),
    updated_at: new Date().toISOString(),
    notes: config.notes?.trim() || undefined,
  };
  fs.writeFileSync(BOOKING_CONFIG_PATH, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
}

function getActiveBookingConfig(): ActiveBookingConfig {
  const fileConfig = loadBookingConfig();
  const fileUrl = normalizeBookingUrl(String(fileConfig.booking_url || ""));
  const envUrl = normalizeBookingUrl(CAL_DIY_BOOKING_URL);

  if (fileUrl) {
    return {
      provider: fileConfig.provider?.trim() || CAL_DIY_PROVIDER_NAME,
      bookingUrl: fileUrl,
      source: "file",
      updatedAt: fileConfig.updated_at,
    };
  }

  if (envUrl) {
    return {
      provider: CAL_DIY_PROVIDER_NAME,
      bookingUrl: envUrl,
      source: "env",
    };
  }

  return {
    provider: fileConfig.provider?.trim() || CAL_DIY_PROVIDER_NAME,
    bookingUrl: "",
    source: "none",
    updatedAt: fileConfig.updated_at,
  };
}

function buildBookingOutreachSnippet(companyName = ""): string {
  const active = getActiveBookingConfig();
  if (!active.bookingUrl) {
    return "[booking link missing — set with /booking set <url>]";
  }

  const opener = companyName.trim()
    ? `If helpful for ${companyName.trim()},`
    : "If helpful,";

  return `${opener} here’s my booking link for a quick 15-minute call: ${active.bookingUrl}`;
}

function getBookingPromptContext(): string {
  const active = getActiveBookingConfig();
  if (!active.bookingUrl) return "";

  return [
    "--- BOOKING LINK CONTEXT ---",
    `Provider: ${active.provider}`,
    `Booking URL: ${active.bookingUrl}`,
    "When drafting outreach emails/messages, include this booking URL as the CTA unless the user says otherwise.",
    "--- END BOOKING LINK CONTEXT ---",
  ].join("\n");
}

async function probeBookingUrl(url: string): Promise<{ ok: boolean; status: number; method: "HEAD" | "GET" | "NONE"; note: string }> {
  const normalized = normalizeBookingUrl(url);
  if (!normalized) {
    return { ok: false, status: 0, method: "NONE", note: "Invalid URL" };
  }

  const request = async (method: "HEAD" | "GET") => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const res = await fetch(normalized, {
        method,
        redirect: "follow",
        signal: controller.signal,
      });
      return {
        ok: res.ok,
        status: res.status,
        method,
        note: res.ok ? "reachable" : `HTTP ${res.status}`,
      } as const;
    } catch (err: any) {
      return {
        ok: false,
        status: 0,
        method,
        note: String(err?.message || "request failed"),
      } as const;
    } finally {
      clearTimeout(timeout);
    }
  };

  const head = await request("HEAD");
  if (head.ok) return head;

  if (head.status === 405 || head.status === 403 || head.status === 0 || head.status >= 500) {
    const get = await request("GET");
    return get;
  }

  return head;
}

type AgentBuildMaterial = {
  id: string;
  category: string;
  name: string;
  url: string;
  use_case: string;
  auth_hosting: string;
  confidence: "verified" | "tested-local" | "candidate" | string;
  notes?: string;
};

type AgentBuildMaterialsRegistry = {
  version?: number;
  updated_at?: string;
  materials?: AgentBuildMaterial[];
};

function loadAgentBuildMaterialsRegistry(): AgentBuildMaterialsRegistry | null {
  try {
    if (!fs.existsSync(MATERIALS_REGISTRY_PATH)) return null;
    const raw = fs.readFileSync(MATERIALS_REGISTRY_PATH, "utf8");
    const parsed = JSON.parse(raw) as AgentBuildMaterialsRegistry;
    if (!parsed || !Array.isArray(parsed.materials)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function materialSearchText(material: AgentBuildMaterial): string {
  return [
    material.id,
    material.category,
    material.name,
    material.url,
    material.use_case,
    material.auth_hosting,
    material.confidence,
    material.notes || "",
  ]
    .join(" ")
    .toLowerCase();
}

function listUniqueMaterialCategories(materials: AgentBuildMaterial[]): string[] {
  return [...new Set(materials.map((m) => m.category.trim().toLowerCase()))].filter(Boolean).sort();
}

function formatMaterialEntry(material: AgentBuildMaterial, index: number): string {
  const lines = [
    `${index}. ${material.name} [${material.category}] (${material.confidence})`,
    `- Use: ${material.use_case}`,
    `- Link: ${material.url}`,
    `- Auth/hosting: ${material.auth_hosting}`,
  ];

  if (material.notes?.trim()) {
    lines.push(`- Notes: ${material.notes.trim()}`);
  }

  return lines.join("\n");
}

// ─── Core: run pi and stream to Telegram ─────────────────────────────────────

async function runPiPrompt(
  ctx: Context,
  chatId: number,
  userText: string,
  senderName?: string
): Promise<void> {
  const state = chatStates.get(sessionKey(chatId))!;
  if (state.busy) {
    await ctx.reply("⏳ Still working on the previous request. Send /abort to cancel.");
    return;
  }

  state.busy = true;

  if (isChowPrimaryChat(chatId)) {
    try {
      maybeRunDailyBrainConsolidation(chatId, "runtime");
      captureBrainUserRequest(chatId, userText, "telegram");
    } catch (brainErr) {
      console.warn(`[brain] pre-prompt capture failed for chat ${chatId}:`, (brainErr as any)?.message ?? brainErr);
    }
  }

  // Optional auto-reset if stuck (disabled by default)
  const stuckTimer = STUCK_TIMEOUT_MS > 0
    ? setTimeout(async () => {
        const currentState = chatStates.get(sessionKey(chatId));
        if (!currentState?.busy) return;
        console.warn(`[STUCK] chatId=${chatId} — aborting after ${Math.round(STUCK_TIMEOUT_MS / 60000)}min`);
        try { await currentState.session.abort(); } catch {}
        currentState.busy = false;
        ctx.reply(`⏱️ Timed out after ${Math.round(STUCK_TIMEOUT_MS / 60000)} minutes. Send your message again.`).catch(() => {});
      }, STUCK_TIMEOUT_MS)
    : null;

  // ── Relay: log user message & fetch group history ──────────────────────────
  const userName = senderName ?? "User";
  await relayPost(chatId, userName, "user", userText);
  const history = await relayGet(chatId, 30);
  const groupContext = formatGroupContext(history, BOT_NAME);
  const joseSnapshotContext = loadJoseSnapshotContext();

  const bookingPromptContext = getBookingPromptContext();

  const promptSegments: string[] = [];
  if (joseSnapshotContext) promptSegments.push(joseSnapshotContext);
  if (groupContext) promptSegments.push(groupContext);
  if (bookingPromptContext) promptSegments.push(bookingPromptContext);
  promptSegments.push(groupContext ? `Latest message from ${userName}: ${userText}` : userText);
  const promptWithContext = promptSegments.join("\n\n");
  const minimalRecoveryPrompt = [
    `Latest message from ${userName}: ${userText}`,
    "",
    "System recovery instruction:",
    "Reply with plain text only.",
    "Do not use tools.",
    "Do not leave the response empty.",
    "Answer only the latest message directly and concisely.",
  ].join("\n");

  const systemPromptEstimate = buildSystemPrompt(chatId, BOT_NAME);
  await maybeAutoCompactSession(
    chatId,
    state,
    `${systemPromptEstimate}\n\n${promptWithContext}`,
    (text) => ctx.reply(text).then(() => undefined)
  );

  // Send a placeholder message we'll edit in real-time
  const placeholder = await ctx.reply("🤔 Thinking...");
  const msgId = placeholder.message_id;

  let fullText = "";
  let toolLine = "";
  let lastEditText = "";
  let editTimer: ReturnType<typeof setInterval> | null = null;

  // Throttled edits
  editTimer = setInterval(async () => {
    const display = buildDisplay(fullText, toolLine);
    if (display !== lastEditText) {
      try {
        await safeEdit(ctx, msgId, display);
        lastEditText = display; // Only update lastEditText if edit succeeded
      } catch (err) {
        // Log but don't update lastEditText so we retry
        console.warn(`[edit] Failed to edit message ${msgId}:`, err);
      }
    }
  }, EDIT_INTERVAL_MS);

  function buildDisplay(text: string, tool: string): string {
    let out = text || "";
    if (tool) out += (out ? "\n\n" : "") + `🔧 \`${tool}\``;
    return truncate(out || "🤔 Thinking...") ;
  }

  try {
    type AssistantTextContent = { type?: string; text?: string };
    type AssistantLikeMessage = {
      role?: string;
      content?: AssistantTextContent[];
    };

    const extractAssistantTextFromMessage = (
      message: AssistantLikeMessage | undefined
    ): string => {
      if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
        return "";
      }

      return message.content
        .filter((content) => content?.type === "text" && typeof content.text === "string")
        .map((content) => content.text as string)
        .join("")
        .trim();
    };

  const extractAssistantTextFromMessages = (
    messages: AssistantLikeMessage[] | undefined
  ): string => {
      if (!Array.isArray(messages) || messages.length === 0) {
        return "";
      }

      for (let i = messages.length - 1; i >= 0; i--) {
        const text = extractAssistantTextFromMessage(messages[i]);
        if (text) return text;
      }
      return "";
    };

    const extractAssistantErrorFromMessage = (
      message: (AssistantLikeMessage & { stopReason?: string; errorMessage?: string }) | undefined
    ): string => {
      if (!message || message.role !== "assistant") {
        return "";
      }
      const stopReason = String((message as any)?.stopReason ?? "");
      const errorMessage = String((message as any)?.errorMessage ?? "").trim();
      if (stopReason === "error" && errorMessage) {
        return `Upstream model error: ${errorMessage}`;
      }
      return "";
    };

    const extractAssistantErrorFromMessages = (
      messages: (AssistantLikeMessage & { stopReason?: string; errorMessage?: string })[] | undefined
    ): string => {
      if (!Array.isArray(messages) || messages.length === 0) {
        return "";
      }
      for (let i = messages.length - 1; i >= 0; i--) {
        const errorText = extractAssistantErrorFromMessage(messages[i]);
        if (errorText) return errorText;
      }
      return "";
    };

    let upstreamErrorText = "";
    let sawUpstreamUsageLimit = false;

    const isUpstreamUsageLimitMessage = (text: string): boolean => {
      const normalized = String(text || "").toLowerCase();
      return normalized.includes("chatgpt usage limit")
        || normalized.includes("usage limit (team plan)")
        || (normalized.includes("usage limit") && normalized.includes("team plan"));
    };

    const captureFinalText = (activeSession: AgentSession): string =>
      fullText.trim() || upstreamErrorText.trim() || activeSession.getLastAssistantText()?.trim() || "";

    const captureFinalTextWithSettle = async (activeSession: AgentSession): Promise<string> => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const candidate = captureFinalText(activeSession);
        if (candidate) return candidate;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return "";
    };

    const subscribeToSession = (activeSession: AgentSession) =>
      activeSession.subscribe((event) => {
        // [TRACE] Log every event to debug empty response
        console.log(`[EVENT] ${event.type} | chatId=${chatId}`);

        switch (event.type) {
          case "message_update": {
            const ev = event.assistantMessageEvent;
            if (ev.type === "text_delta") {
              fullText += ev.delta;
              toolLine = "";
            }
            break;
          }

          case "message_end": {
            console.log(`[TRACE] Message end payload: ${JSON.stringify(event.message).slice(0, 200)}...`);
            const stopReason = (event.message as any)?.stopReason;
            const errorMessage = (event.message as any)?.errorMessage;
            const contentCount = Array.isArray((event.message as any)?.content)
              ? (event.message as any).content.length
              : null;
            if (!contentCount || stopReason === "error" || errorMessage) {
              console.warn(
                `[TRACE_EMPTY] chatId=${chatId} stopReason=${String(stopReason ?? "")} contentCount=${String(contentCount ?? "")} error=${String(errorMessage ?? "")}`
              );
            }
            const completedText = extractAssistantTextFromMessage(
              event.message as AssistantLikeMessage | undefined
            );
            if (completedText) {
              fullText = completedText;
              upstreamErrorText = "";
            } else {
              const extractedError = extractAssistantErrorFromMessage(event.message as any);
              if (extractedError) {
                upstreamErrorText = extractedError;
                if (isUpstreamUsageLimitMessage(extractedError)) {
                  sawUpstreamUsageLimit = true;
                }
              }
            }
            toolLine = "";
            break;
          }

          case "agent_end": {
            console.log(`[TRACE] Agent end. Message count: ${(event as any).messages?.length ?? 0}`);
            const fromAgentEnd = extractAssistantTextFromMessages(
              (event as { messages?: AssistantLikeMessage[] }).messages
            );
            if (fromAgentEnd && !fullText.trim()) {
              fullText = fromAgentEnd;
              upstreamErrorText = "";
            } else {
              const extractedError = extractAssistantErrorFromMessages((event as { messages?: any[] }).messages);
              if (extractedError && !fullText.trim()) {
                upstreamErrorText = extractedError;
                if (isUpstreamUsageLimitMessage(extractedError)) {
                  sawUpstreamUsageLimit = true;
                }
              }
            }
            toolLine = "";
            break;
          }

          case "tool_execution_start":
            console.log(`[TRACE] Tool start: ${event.toolName}`);
            toolLine = event.toolName;
            break;

          case "tool_execution_end":
            toolLine = "";
            break;
        }
      });

    let session = state.session;
    let unsub = subscribeToSession(session);

    const runPromptAttempt = async (
      activeSession: AgentSession,
      promptText: string,
      streamingBehavior: "steer" | "followUp" = "steer"
    ): Promise<string> => {
      await activeSession.prompt(promptText, { streamingBehavior });
      return captureFinalTextWithSettle(activeSession);
    };

    await session.prompt(promptWithContext, { streamingBehavior: "steer" });

    let finalText = await captureFinalTextWithSettle(session);

    if (isUpstreamUsageLimitMessage(finalText)) {
      sawUpstreamUsageLimit = true;
      finalText = "";
    }

    if (!finalText && sawUpstreamUsageLimit) {
      console.warn(`[UPSTREAM_USAGE_LIMIT] chatId=${chatId} — skipping same-lane retries and jumping to fallback providers`);
    }

    if (!finalText && !sawUpstreamUsageLimit) {
      console.warn(`[EMPTY_RESPONSE] chatId=${chatId} — resetting session and retrying once`);
      unsub();
      fullText = "";
      upstreamErrorText = "";
      toolLine = "";
      lastEditText = "";
      await safeEdit(ctx, msgId, "⚠️ Empty response glitch — resetting session and retrying...");

      session = await resetSession(chatId, false);
      chatStates.get(sessionKey(chatId))!.busy = true;
      unsub = subscribeToSession(session);

      finalText = await runPromptAttempt(session, promptWithContext, "steer");
    }

    if (!finalText && !sawUpstreamUsageLimit) {
      console.warn(`[EMPTY_RESPONSE] chatId=${chatId} — last-resort plain-text retry`);
      unsub();
      fullText = "";
      upstreamErrorText = "";
      toolLine = "";
      lastEditText = "";
      await safeEdit(ctx, msgId, "⚠️ Empty response glitch again — forcing a plain-text recovery...");

      session = await resetSession(chatId, false);
      chatStates.get(sessionKey(chatId))!.busy = true;
      unsub = subscribeToSession(session);

      finalText = await runPromptAttempt(session, minimalRecoveryPrompt, "steer");
    }

    if (!finalText && !sawUpstreamUsageLimit && CHOW_AUTH_ROTATION_ENABLED && CHOW_AUTH_ROTATION_MAX_ATTEMPTS > 0) {
      for (let authAttempt = 0; authAttempt < CHOW_AUTH_ROTATION_MAX_ATTEMPTS && !finalText; authAttempt++) {
        console.warn(`[EMPTY_RESPONSE] chatId=${chatId} — marking current auth failed and rotating saved profile`);
        markCurrentAuthResult("failure", "empty_response");
        const rotation = rotateToNextAuthProfile();
        if (!rotation?.rotated) {
          console.warn(`[EMPTY_RESPONSE] chatId=${chatId} — no alternate auth profile available`);
          break;
        }

        unsub();
        fullText = "";
        upstreamErrorText = "";
        toolLine = "";
        lastEditText = "";
        await safeEdit(
          ctx,
          msgId,
          `⚠️ Empty response on current account — rotating auth to ${rotation.email || rotation.to} and retrying...`
        );

        session = await resetSession(chatId, false);
        chatStates.get(sessionKey(chatId))!.busy = true;
        unsub = subscribeToSession(session);

        finalText = await runPromptAttempt(session, minimalRecoveryPrompt, "steer");
        if (finalText) {
          markCurrentAuthResult("success", "post_rotation_recovery");
          break;
        }
      }
    }

    if (!finalText) {
      const attemptedKeys = [
        `${chowModelSelection.provider}/${chowModelSelection.modelId}`,
        `${session.model?.provider ?? ""}/${session.model?.id ?? ""}`,
      ];
      unsub();
      fullText = "";
      upstreamErrorText = "";
      toolLine = "";
      lastEditText = "";
      const fallbackResult = await tryFallbackChain(
        chatId,
        attemptedKeys,
        async (selection) => {
          await safeEdit(
            ctx,
            msgId,
            sawUpstreamUsageLimit
              ? `⚠️ OpenAI lane is capped right now — switching Chow to ${selection.provider}/${selection.modelId}...`
              : `⚠️ Empty response glitch again — switching Chow to ${selection.provider}/${selection.modelId}...`
          );
        },
        (activeSession) => {
          chatStates.get(sessionKey(chatId))!.busy = true;
          return subscribeToSession(activeSession);
        },
        runPromptAttempt,
        minimalRecoveryPrompt
      );

      finalText = fallbackResult.finalText;
      if (fallbackResult.session) {
        session = fallbackResult.session;
      }
      unsub = fallbackResult.unsub ?? (() => {});
    }

    unsub();

    // Final edit
    if (editTimer) clearInterval(editTimer);

    if (!finalText) {
      finalText = "⚠️ I hit an upstream empty-response failure after retrying and model failover. Try one short sentence or `/new` to start a fresh session.";
    }

    // ── Relay: check if bot wants to skip ─────────────────────────────────────
    if (finalText === "[SKIP]") {
      console.log(`[${new Date().toISOString()}] ${BOT_NAME} skipped this message`);
      try { await ctx.telegram.deleteMessage(ctx.chat!.id, msgId); } catch {}
      return;
    }

    if (isChowPrimaryChat(chatId)) {
      try {
        captureBrainAssistantResult(chatId, finalText, "telegram");
      } catch (brainErr) {
        console.warn(`[brain] post-prompt capture failed for chat ${chatId}:`, (brainErr as any)?.message ?? brainErr);
      }
    }

    // ── Relay: log our response ───────────────────────────────────────────────
    await relayPost(chatId, BOT_NAME, "bot", finalText);

    console.log(`[${new Date().toISOString()}] → replied (${finalText.length} chars)`);
    const chunks = splitMessage(finalText);

    // Edit the placeholder with first chunk
    try {
      await safeEdit(ctx, msgId, chunks[0]);
    } catch (editErr: any) {
      const desc = String(editErr?.message ?? editErr);
      // "message is not modified" = content already correct, ignore
      if (!desc.includes("message is not modified")) {
        // Placeholder may be gone — send as new message
        await safeSend(ctx, chunks[0]);
      }
    }

    // Send remaining chunks as new messages (with retries so long outputs are not dropped)
    for (let i = 1; i < chunks.length; i++) {
      try {
        await safeSend(ctx, chunks[i]);
      } catch (chunkErr: any) {
        console.warn(`[reply] Failed to send chunk ${i + 1}/${chunks.length}:`, chunkErr?.message ?? chunkErr);
        const snippet = truncate(chunks[i], 220);
        await safeSend(ctx, `⚠️ I hit a transient Telegram send error while sending a long response. Resend this prompt and I’ll continue from where it failed.\n\nFailed chunk preview:\n${snippet}`);
        break;
      }
    }

    await maybeSendVoiceReply(ctx, chatId, finalText);
  } catch (err: any) {
    if (editTimer) clearInterval(editTimer);
    const rawErr = String(err?.message ?? err);
    const errMsg = rawErr.includes('No API key found for "openai-codex"')
      ? "❌ Error: openai-codex auth failed at runtime. Chow uses host OAuth, not a Telegram /login flow."
      : `❌ Error: ${rawErr}`;
    try {
      await safeEdit(ctx, msgId, errMsg);
    } catch (editErr: any) {
      const desc = String(editErr?.message ?? editErr);
      if (!desc.includes("message is not modified")) {
        await safeSend(ctx, errMsg);
      }
    }
  } finally {
    if (stuckTimer) clearTimeout(stuckTimer);
    const currentState = chatStates.get(sessionKey(chatId));
    if (currentState) currentState.busy = false;
  }
}

function buildHivePromptWithContext(history: HiveMessage[], roomName: string, senderName: string, userText: string): string {
  const transcript = history
    .filter((msg) => !!String(msg?.text || "").trim())
    .slice(-20)
    .map((msg) => `${msg.authorName || "Unknown"} [${msg.authorType || "user"}]: ${String(msg.text || "").trim()}`)
    .join("\n");

  if (transcript) {
    return `You are ${BOT_NAME}, replying inside Hive room "${roomName}".
Recent thread transcript:
${transcript}

Reply to the latest human message from ${senderName}: ${userText}`;
  }

  return `You are ${BOT_NAME}, replying inside Hive room "${roomName}".
Latest human message from ${senderName}: ${userText}`;
}

async function runHiveTurn({ thread, message, history, runtime }: HiveRunTurnInput): Promise<HiveRunTurnResult | string> {
  const channelId = `hive:${thread.id}`;
  const state = chatStates.get(sessionKey(channelId)) ?? (await getOrCreateSession(channelId), chatStates.get(sessionKey(channelId))!);
  state.busy = true;

  let fullText = "";
  let session = state.session;
  let toolLine = "";

  type AssistantTextContent = { type?: string; text?: string };
  type AssistantLikeMessage = {
    role?: string;
    content?: AssistantTextContent[];
  };

  const extractAssistantTextFromMessage = (assistantMessage: AssistantLikeMessage | undefined): string => {
    if (!assistantMessage || assistantMessage.role !== "assistant" || !Array.isArray(assistantMessage.content)) return "";
    return assistantMessage.content
      .filter((content) => content?.type === "text" && typeof content.text === "string")
      .map((content) => content.text as string)
      .join("")
      .trim();
  };

  const extractAssistantTextFromMessages = (messages: AssistantLikeMessage[] | undefined): string => {
    if (!Array.isArray(messages) || messages.length === 0) return "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const text = extractAssistantTextFromMessage(messages[i]);
      if (text) return text;
    }
    return "";
  };

  const extractAssistantErrorFromMessage = (
    message: (AssistantLikeMessage & { stopReason?: string; errorMessage?: string }) | undefined
  ): string => {
    if (!message || message.role !== "assistant") {
      return "";
    }
    const stopReason = String((message as any)?.stopReason ?? "");
    const errorMessage = String((message as any)?.errorMessage ?? "").trim();
    if (stopReason === "error" && errorMessage) {
      return `Upstream model error: ${errorMessage}`;
    }
    return "";
  };

  const extractAssistantErrorFromMessages = (
    messages: (AssistantLikeMessage & { stopReason?: string; errorMessage?: string })[] | undefined
  ): string => {
    if (!Array.isArray(messages) || messages.length === 0) {
      return "";
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const errorText = extractAssistantErrorFromMessage(messages[i]);
      if (errorText) return errorText;
    }
    return "";
  };

  let upstreamErrorText = "";

  const captureFinalText = (activeSession: AgentSession): string =>
    fullText.trim() || upstreamErrorText.trim() || activeSession.getLastAssistantText()?.trim() || "";

  const captureFinalTextWithSettle = async (activeSession: AgentSession): Promise<string> => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate = captureFinalText(activeSession);
      if (candidate) return candidate;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return "";
  };

  const subscribeToSession = (activeSession: AgentSession) =>
    activeSession.subscribe((event) => {
      switch (event.type) {
        case "message_update": {
          const ev = event.assistantMessageEvent;
          if (ev.type === "text_delta") {
            fullText += ev.delta;
          }
          break;
        }
        case "message_end": {
          const stopReason = (event.message as any)?.stopReason;
          const errorMessage = (event.message as any)?.errorMessage;
          const contentCount = Array.isArray((event.message as any)?.content)
            ? (event.message as any).content.length
            : null;
          if (!contentCount || stopReason === "error" || errorMessage) {
            console.warn(
              `[TRACE_EMPTY][hive] room=${thread.id} stopReason=${String(stopReason ?? "")} contentCount=${String(contentCount ?? "")} error=${String(errorMessage ?? "")}`
            );
          }
          const completedText = extractAssistantTextFromMessage(event.message as AssistantLikeMessage | undefined);
          if (completedText) {
            fullText = completedText;
            upstreamErrorText = "";
          } else {
            const extractedError = extractAssistantErrorFromMessage(event.message as any);
            if (extractedError) upstreamErrorText = extractedError;
          }
          break;
        }
        case "agent_end": {
          const fromAgentEnd = extractAssistantTextFromMessages((event as { messages?: AssistantLikeMessage[] }).messages);
          if (fromAgentEnd && !fullText.trim()) {
            fullText = fromAgentEnd;
            upstreamErrorText = "";
          } else {
            const extractedError = extractAssistantErrorFromMessages((event as { messages?: any[] }).messages);
            if (extractedError && !fullText.trim()) upstreamErrorText = extractedError;
          }
          break;
        }
        case "tool_execution_start":
          toolLine = event.toolName;
          runtime.toolStatus(event.toolName);
          break;
        case "tool_execution_end":
          toolLine = "";
          runtime.toolStatus(null);
          break;
      }
    });

  let unsub = subscribeToSession(session);

  try {
    const latestUserText = String(message.text || "");
    const promptWithContext = buildHivePromptWithContext(history, thread.name, message.authorName || "User", latestUserText);
    const minimalRecoveryPrompt = [
      `Latest message from ${message.authorName || "User"}: ${latestUserText}`,
      "",
      "System recovery instruction:",
      "Reply with plain text only.",
      "Do not use tools.",
      "Do not leave the response empty.",
      "Answer only the latest message directly and concisely.",
    ].join("\n");
    await maybeAutoCompactSession(
      channelId,
      chatStates.get(sessionKey(channelId))!,
      `${buildSystemPrompt(channelId, BOT_NAME)}\n\n${promptWithContext}`,
      async (text) => runtime.toolStatus(text.slice(0, 120))
    );
    session = chatStates.get(sessionKey(channelId))!.session;
    await session.prompt(promptWithContext, { streamingBehavior: "steer" });

    let finalText = await captureFinalTextWithSettle(session);
    if (!finalText) {
      console.warn(`[hive] Empty response in room ${thread.id}; resetting session and retrying once`);
      unsub();
      fullText = "";
      upstreamErrorText = "";
      toolLine = "";
      session = await resetSession(channelId, false);
      chatStates.get(sessionKey(channelId))!.busy = true;
      unsub = subscribeToSession(session);
      await session.prompt(promptWithContext, { streamingBehavior: "steer" });
      finalText = await captureFinalTextWithSettle(session);
    }

    if (!finalText) {
      console.warn(`[hive] Empty response in room ${thread.id}; forcing minimal plain-text recovery`);
      unsub();
      fullText = "";
      upstreamErrorText = "";
      toolLine = "";
      session = await resetSession(channelId, false);
      chatStates.get(sessionKey(channelId))!.busy = true;
      unsub = subscribeToSession(session);
      await session.prompt(minimalRecoveryPrompt, { streamingBehavior: "steer" });
      finalText = await captureFinalTextWithSettle(session);
    }

    if (!finalText && CHOW_AUTH_ROTATION_ENABLED && CHOW_AUTH_ROTATION_MAX_ATTEMPTS > 0) {
      for (let authAttempt = 0; authAttempt < CHOW_AUTH_ROTATION_MAX_ATTEMPTS && !finalText; authAttempt++) {
        console.warn(`[hive] Empty response in room ${thread.id}; rotating saved auth profile`);
        markCurrentAuthResult("failure", "empty_response");
        const rotation = rotateToNextAuthProfile();
        if (!rotation?.rotated) {
          console.warn(`[hive] Empty response in room ${thread.id}; no alternate auth profile available`);
          break;
        }

        unsub();
        fullText = "";
        upstreamErrorText = "";
        toolLine = "";
        session = await resetSession(channelId, false);
        chatStates.get(sessionKey(channelId))!.busy = true;
        unsub = subscribeToSession(session);
        await session.prompt(minimalRecoveryPrompt, { streamingBehavior: "steer" });
        finalText = await captureFinalTextWithSettle(session);
        if (finalText) {
          markCurrentAuthResult("success", "post_rotation_recovery");
          break;
        }
      }
    }

    if (!finalText) {
      const attemptedKeys = [
        `${chowModelSelection.provider}/${chowModelSelection.modelId}`,
        `${session.model?.provider ?? ""}/${session.model?.id ?? ""}`,
      ];
      unsub();
      fullText = "";
      upstreamErrorText = "";
      toolLine = "";
      const fallbackResult = await tryFallbackChain(
        channelId,
        attemptedKeys,
        async (selection) => {
          console.warn(
            `[hive] Empty response in room ${thread.id}; switching to fallback model ${selection.provider}/${selection.modelId}`
          );
        },
        (activeSession) => {
          chatStates.get(sessionKey(channelId))!.busy = true;
          return subscribeToSession(activeSession);
        },
        runPromptAttempt,
        minimalRecoveryPrompt
      );
      finalText = fallbackResult.finalText;
      if (fallbackResult.session) {
        session = fallbackResult.session;
      }
      unsub = fallbackResult.unsub ?? (() => {});
    }

    if (!finalText) {
      finalText = "⚠️ I hit an upstream empty-response failure after retrying and model failover. Try one short sentence or `/new` to start a fresh session.";
    }

    if (finalText === "[SKIP]") {
      return { skip: true };
    }

    return {
      text: finalText,
      meta: { hiveAutoReply: true, source: "chow_hive_loop" },
    };
  } catch (error: any) {
    console.error(`[hive] prompt failed for room ${thread.id}:`, error?.message ?? error);
    return {
      text: `❌ Error: ${error?.message ?? String(error)}`,
      meta: { hiveAutoReply: true, source: "chow_hive_loop_error" },
    };
  } finally {
    unsub();
    if (toolLine) runtime.toolStatus(null);
    const currentState = chatStates.get(sessionKey(channelId));
    if (currentState) currentState.busy = false;
  }
}

async function compactHiveTurn(threadId: string) {
  const channelId = `hive:${threadId}`;
  const state = chatStates.get(sessionKey(channelId)) ?? (await getOrCreateSession(channelId), chatStates.get(sessionKey(channelId))!);
  const beforeMessages = state.session.messages.length;
  await state.session.compact();
  const afterMessages = state.session.messages.length;
  return {
    beforeContextPct: null,
    afterContextPct: null,
    checkpointLabel: `messages ${beforeMessages}→${afterMessages}`,
    summary: "Compacted Chow's Hive session state.",
  };
}

async function connectHiveLoop(): Promise<void> {
  if (!HIVE_ENABLED || hiveRuntime) return;

  hiveRuntime = new HiveAgentRuntime({
    url: HIVE_WS_URL,
    httpUrl: HIVE_HTTP_URL,
    apiKey: HIVE_AGENT_API_KEY,
    autoReconnect: true,
    historyLimit: 20,
    driver: {
      shouldHandleMessage: ({ message }) => message.authorType === "human" && !!String(message.text || "").trim(),
      runTurn: runHiveTurn,
      compact: ({ thread }) => compactHiveTurn(thread.id),
    },
  });

  await hiveRuntime.connect();
  console.log(`[hive] Connected via reusable runtime adapter: ${HIVE_WS_URL}`);
}

function startBrainDailyScheduler(): void {
  if (BOT_NAME.toLowerCase() === "jose") return;

  const tick = () => {
    try {
      const result = maybeRunDailyBrainConsolidation(CHOW_PRIMARY_CHAT_ID, "scheduler");
      if (result.ran) {
        console.log(`[brain] daily consolidation: ${result.date} events=${result.eventCount ?? 0}`);
      }
    } catch (err: any) {
      console.error(`[brain] scheduler tick failed:`, err?.message ?? err);
    }
  };

  tick();

  if (CHOW_BRAIN_DAILY_TICK_MS > 0) {
    brainDailyTimer = setInterval(tick, CHOW_BRAIN_DAILY_TICK_MS);
    brainDailyTimer.unref?.();
  }
}

// ─── Bot setup ────────────────────────────────────────────────────────────────

const bot = new Telegraf(BOT_TOKEN);

// Auth middleware — silent ignore for unauthorized chats (no reply = no crash)
bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id;
  if (!chatId || !isAllowed(chatId)) {
    console.log(`[AUTH BLOCKED] chat_id=${chatId} type=${ctx.chat?.type} title=${(ctx.chat as any)?.title ?? "dm"}`);
    return; // silent — don't reply, avoids crash if bot was kicked
  }
  await next();
});

// Commands
async function handleMeetCommand(ctx: Context): Promise<void> {
  // ... (existing content)
}

async function handleMeetSnapshotCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply("Snapshot command requires a valid chat context.");
    return;
  }

  if (!isMeetSidecarEnabled()) {
    await ctx.reply("🚫 Meet sidecar is disabled.");
    return;
  }

  const state = getMeetChatState(chatId);
  const sessionId = (state?.sessionId || "").trim();

  if (!sessionId) {
    await ctx.reply("❌ No active Meet session found. Join a meeting first with /meet join <url>.");
    return;
  }

  await ctx.reply(`📸 Taking a snapshot of session ${sessionId}...`);

  try {
    const result = await meetScreenshot(sessionId);
    if (!result.ok) {
      await ctx.reply(`❌ Snapshot failed: ${result.error || "unknown error"}`);
      return;
    }

    const screenshotPath = (result.data as any)?.screenshotPath;
    if (!screenshotPath || !fs.existsSync(screenshotPath)) {
      await ctx.reply(`❌ Snapshot succeeded but file not found: ${screenshotPath || "null"}`);
      return;
    }

    await ctx.replyWithPhoto({ source: screenshotPath, caption: `📸 Snapshot of ${sessionId}` });
  } catch (err: any) {
    console.error(`[meet-snapshot] Error:`, err);
    await ctx.reply(`❌ Internal error taking snapshot: ${err?.message || err}`);
  }
}

async function handleBookingCommand(ctx: Context): Promise<void> {
  const raw = (ctx.message && "text" in ctx.message ? ctx.message.text : "")
    .replace(/^\/(?:booking|calendar)(?:@\w+)?\s*/i, "")
    .trim();

  const [sub = "status", ...rest] = raw.split(/\s+/).filter(Boolean);
  const command = sub.toLowerCase();
  const argText = rest.join(" ").trim();

  if (command === "help" || command === "status") {
    const active = getActiveBookingConfig();
    const lines = [
      "📅 Booking link status",
      `Provider: ${active.provider}`,
      `Source: ${active.source}`,
      `URL: ${active.bookingUrl || "(not set)"}`,
      active.updatedAt ? `Updated: ${active.updatedAt}` : "",
      "",
      "Commands:",
      "/booking set <url> — save booking link",
      "/booking test — verify link reachability",
      "/booking snippet [company] — outreach CTA line",
      "/booking clear — remove saved booking link",
      "/calendar ... — alias of /booking",
    ].filter(Boolean);

    await ctx.reply(lines.join("\n"));
    return;
  }

  if (command === "set") {
    const normalized = normalizeBookingUrl(argText);
    if (!normalized) {
      await ctx.reply("Usage: /booking set <https://your-cal-link>");
      return;
    }

    const existing = loadBookingConfig();
    saveBookingConfig({
      ...existing,
      provider: CAL_DIY_PROVIDER_NAME,
      booking_url: normalized,
    });

    await ctx.reply(
      [
        "✅ Booking link saved",
        `Provider: ${CAL_DIY_PROVIDER_NAME}`,
        `URL: ${normalized}`,
        `Config file: ${BOOKING_CONFIG_PATH}`,
      ].join("\n")
    );
    return;
  }

  if (command === "clear") {
    const existing = loadBookingConfig();
    saveBookingConfig({
      ...existing,
      provider: CAL_DIY_PROVIDER_NAME,
      booking_url: "",
    });
    await ctx.reply("🧹 Cleared saved booking link. (Env CAL_DIY_BOOKING_URL still applies if set.)");
    return;
  }

  if (command === "test") {
    const active = getActiveBookingConfig();
    if (!active.bookingUrl) {
      await ctx.reply("No booking URL set. Use /booking set <url> first.");
      return;
    }

    await ctx.reply(`Testing booking URL...\n${active.bookingUrl}`);
    const probe = await probeBookingUrl(active.bookingUrl);
    const statusLine = probe.status ? `HTTP ${probe.status}` : "no HTTP status";
    await ctx.reply(
      [
        probe.ok ? "✅ Booking URL reachable" : "❌ Booking URL check failed",
        `Method: ${probe.method}`,
        `Status: ${statusLine}`,
        `Detail: ${probe.note}`,
      ].join("\n")
    );
    return;
  }

  if (command === "snippet") {
    const companyName = argText;
    const snippet = buildBookingOutreachSnippet(companyName);
    await ctx.reply([
      "✉️ Outreach snippet:",
      snippet,
    ].join("\n\n"));
    return;
  }

  await ctx.reply("Unknown /booking command. Use /booking help");
}

bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  await getOrCreateSession(chatId);
  const joseExtras = BOT_NAME.toLowerCase() === "jose"
    ? `\n/brief — Snapshot triage overview\n/urgent — High-priority queue\n/topics — Topic lanes + load mode\n/events — Recent unread delta events\n/ask <query> — Grounded snapshot retrieval`
    : "";
  const brainExtras = isChowPrimaryChat(chatId)
    ? `\n/brain peek [n] — Recent structured memories\n/brain search <query> — Ranked memory retrieval\n/brain add <note> — Save explicit memory note\n/brain status — Brain event/consolidation status\n/brain consolidate — Force daily consolidation`
    : "";
  const voiceExtras = `\n/voice — Voice input status and usage`;

  await ctx.reply(
    `👋 *Pi Coding Agent* is ready!\n\n` +
      `Send me any message and I'll use Claude + pi's full toolkit to help.\n` +
      `You can also send voice notes${VOICE_ENABLED ? " (transcription enabled)" : " (voice transcription not configured yet)"}.\n\n` +
      `*Commands:*\n` +
      `/new — Start a fresh session\n` +
      `/compact — Compact the conversation\n` +
      `/abort — Abort current task\n` +
      `/status — Show session info\n` +
      `/models — List available models\n` +
      `/model <id> — Switch current model
` +
      `/materials [query] — Agent build materials library
` +
      `/booking [status|set|test|snippet|clear] — Cal.diy booking link control
` +
      `/meet [help|setup|join|status|recover|speak|leave|doctor] — Google Meet sidecar control` +
      voiceExtras +
      joseExtras +
      brainExtras,
    { parse_mode: "Markdown" }
  );
});

bot.command("new", async (ctx) => {
  const chatId = ctx.chat.id;
  const state = chatStates.get(sessionKey(chatId));
  if (state?.busy) {
    await ctx.reply("⏳ Can't reset while busy. Send /abort first.");
    return;
  }
  await ctx.reply("🧠 Saving memory from this session, then starting fresh...");
  await resetSession(chatId, true);
  await ctx.reply("✅ Fresh session ready! I remember everything important from before.");
});

bot.command("compact", async (ctx) => {
  const chatId = ctx.chat.id;
  const state = chatStates.get(sessionKey(chatId));
  if (!state) {
    await ctx.reply("No active session. Send a message first.");
    return;
  }
  if (state.busy) {
    await ctx.reply("⏳ Busy right now.");
    return;
  }
  const beforeMessages = state.session.messages.length;
  const beforeContext = estimateSessionContext(state.session, buildSystemPrompt(chatId, BOT_NAME));
  await ctx.reply(`🗜️ Compacting... (${formatContextEstimate(beforeContext)})`);
  try {
    await state.session.compact();
    const afterMessages = state.session.messages.length;
    const afterContext = estimateSessionContext(state.session, buildSystemPrompt(chatId, BOT_NAME));
    await ctx.reply(`✅ Compaction done: ${beforeMessages}→${afterMessages} messages, ${formatContextEstimate(afterContext)}.`);
  } catch (e: any) {
    await ctx.reply(`❌ Compaction failed: ${e?.message}`);
  }
});

bot.command("abort", async (ctx) => {
  const chatId = ctx.chat.id;
  const state = chatStates.get(sessionKey(chatId));
  if (!state?.busy) {
    await ctx.reply("Nothing running.");
    return;
  }
  await state.session.abort();
  state.busy = false;
  await ctx.reply("🛑 Aborted.");
});

bot.command("status", async (ctx) => {
  const chatId = ctx.chat.id;
  const state = chatStates.get(sessionKey(chatId));
  if (!state) {
    await ctx.reply("No active session yet.");
    return;
  }
  const model = state.session.model;
  const modelStr = model ? `${model.provider}/${model.id}` : "unknown";
  const thinkingLevel = (state.session as any).thinkingLevel ?? "?";
  const msgs = state.session.messages.length;
  const contextEstimate = estimateSessionContext(state.session, buildSystemPrompt(chatId, BOT_NAME));
  const autoCompactLine = AUTO_COMPACT_ENABLED
    ? `${Math.round(AUTO_COMPACT_CONTEXT_RATIO * 100)}% / min ${AUTO_COMPACT_MIN_TOKENS.toLocaleString()} tok`
    : "disabled";
  const sessionFile = state.session.sessionFile ?? "in-memory";
  await ctx.reply(
    `📊 *Session Status*\n` +
      `Model: \`${modelStr}\`\n` +
      `Thinking: \`${thinkingLevel}\`\n` +
      `Messages: ${msgs}\n` +
      `Context est: \`${formatContextEstimate(contextEstimate)}\`\n` +
      `Auto-compact: \`${autoCompactLine}\`\n` +
      `Busy: ${state.busy ? "Yes" : "No"}\n` +
      `Session: \`${path.basename(sessionFile)}\``,
    { parse_mode: "Markdown" }
  );
});

bot.command("voice", async (ctx) => {
  const chatId = ctx.chat.id;
  const raw = (ctx.message?.text || "").replace(/^\/voice(?:@\w+)?\s*/i, "").trim().toLowerCase();

  if (raw === "on") {
    if (!VOICE_ENABLED) {
      await ctx.reply("🎙️ Can't enable voice replies yet — set GEMINI_API_KEY (or OPENAI_API_KEY fallback) and restart.");
      return;
    }
    setVoiceReplyPreferred(chatId, true);
    await ctx.reply("✅ Voice replies enabled for this chat. I'll answer with text + voice.");
    return;
  }

  if (raw === "off") {
    setVoiceReplyPreferred(chatId, false);
    await ctx.reply("✅ Voice replies disabled for this chat. I'll answer with text only.");
    return;
  }

  if (raw === "test") {
    if (!VOICE_ENABLED) {
      await ctx.reply("🎙️ Voice is not configured. Set GEMINI_API_KEY (or OPENAI_API_KEY fallback) and restart.");
      return;
    }
    await ctx.reply("🎙️ Running voice test...");
    try {
      const audio = await synthesizeVoiceReply("Voice test successful. If you can hear this, voice replies are working.");
      await sendSynthesizedAudio(ctx, audio);
    } catch (err: any) {
      await ctx.reply(`❌ Voice test failed: ${err?.message ?? "unknown"}`);
    }
    return;
  }

  const voiceReplyOn = isVoiceReplyPreferred(chatId);
  if (VOICE_ENABLED) {
    await ctx.reply(
      `🎙️ Voice input is enabled.\n` +
      `- Send a Telegram voice note/audio and I'll transcribe it.\n` +
      `- Voice replies are currently *${voiceReplyOn ? "ON" : "OFF"}* for this chat.\n\n` +
      `Commands:\n` +
      `/voice on — enable voice replies\n` +
      `/voice off — disable voice replies\n` +
      `/voice test — send a sample voice reply\n\n` +
      `Provider: \`${VOICE_PROVIDER}\`\n` +
      `Transcription model: \`${VOICE_TRANSCRIBE_MODEL}\`\n` +
      `Reply model: \`${VOICE_REPLY_MODEL}\`\n` +
      `Reply voice: \`${VOICE_REPLY_VOICE}\`` +
      (VOICE_TRANSCRIBE_LANGUAGE ? `\nLanguage hint: \`${VOICE_TRANSCRIBE_LANGUAGE}\`` : ""),
      { parse_mode: "Markdown" }
    );
    return;
  }

  await ctx.reply(
    "🎙️ Voice mode is currently disabled.\n" +
      "Set GEMINI_API_KEY in .env (preferred) and restart to enable voice-note transcription + voice replies. OPENAI_API_KEY remains supported as fallback."
  );
});

bot.command("login", async (ctx) => {
  const chatId = ctx.chat.id;
  const session = await getOrCreateSession(chatId);
  // @ts-ignore - attached on AgentSession by pi-coding-agent
  const registry = session.modelRegistry;
  const model = session.model;
  const provider = model?.provider || chowModelSelection.provider;

  if (!registry || !provider) {
    await ctx.reply("Login status is unavailable right now. Try again in a moment.");
    return;
  }

  try {
    const usingOAuth = model ? registry.isUsingOAuth(model) : false;
    const hasProviderCredential = await registry.getApiKeyForProvider(provider);
    const currentModel = model
      ? `${model.provider}/${model.id}`
      : `${chowModelSelection.provider}/${chowModelSelection.modelId}`;

    if (usingOAuth || hasProviderCredential) {
      await ctx.reply(
        `🔐 Chow is already configured for \`${provider}\`.\n\n` +
        `Current model: \`${currentModel}\`\n` +
        `This Telegram bot does not support interactive OAuth login from chat. If replies fail, the issue is runtime-side, not a missing /login step.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    await ctx.reply(
      `⚠️ No credentials are available for \`${provider}\`.\n` +
      `This bot cannot complete interactive OAuth login inside Telegram. Auth has to be installed on the host runtime.`,
      { parse_mode: "Markdown" }
    );
  } catch (err: any) {
    await ctx.reply(`❌ Login check failed: ${err?.message ?? "unknown error"}`);
  }
});

bot.command("models", async (ctx) => {
  const chatId = ctx.chat.id;
  const state = await getOrCreateSession(chatId);
  // @ts-ignore - modelRegistry is a getter
  const registry = state.modelRegistry;
  if (!registry) {
    await ctx.reply("Model registry not available.");
    return;
  }
  const models = await registry.getAvailable();
  const filtered = models.filter((m: any) => m.provider === "openai-codex" || m.provider === "anthropic");
  const list = filtered.map((m: any) => `• \`${m.provider}/${m.id}\``).join("\n");
  await ctx.reply(`🤖 *Available Models:*\n\n${list}`, { parse_mode: "Markdown" });
});

bot.command("model", async (ctx) => {
  const chatId = ctx.chat.id;
  const state = chatStates.get(sessionKey(chatId));
  if (!state) {
    await ctx.reply("No active session yet.");
    return;
  }
  const text = ctx.message.text;
  const modelId = text.split(/\s+/).slice(1).join(" ").trim();
  
  if (!modelId) {
    const current = state.session.model;
    const currentStr = current ? `${current.provider}/${current.id}` : "unknown";
    await ctx.reply(`Current model: \`${currentStr}\`\n\nTo switch: \`/model <provider>/<id>\`\nSee \`/models\` for list.`, { parse_mode: "Markdown" });
    return;
  }
  
  let provider, id;
  if (modelId.includes("/")) {
    [provider, id] = modelId.split("/");
  } else {
    provider = "openai-codex";
    id = modelId;
  }

  // @ts-ignore
  const registry = state.session.modelRegistry;
  const model = registry.find(provider, id);
  
  if (!model) {
    await ctx.reply(`❌ Model \`${modelId}\` not found.`);
    return;
  }
  
  try {
    await state.session.setModel(model);
    await ctx.reply(`✅ Switched to \`${model.provider}/${model.id}\``, { parse_mode: "Markdown" });
  } catch (e: any) {
    await ctx.reply(`❌ Failed to switch model: ${e.message}`);
  }
});

// ── Quick model toggles ────────────────────────────────────────────────────

bot.command("gpt", async (ctx) => {
  const chatId = ctx.chat.id;
  const state = chatStates.get(sessionKey(chatId));
  if (!state) { await ctx.reply("No active session."); return; }
  const registry = (state.session as any).modelRegistry;
  const model = registry.find("openai-codex", "gpt-5.5");
  if (!model) { await ctx.reply("❌ GPT 5.5 not found in model registry."); return; }
  try {
    await state.session.setModel(model);
    await ctx.reply("✅ *GPT 5.5* — `openai-codex/gpt-5.5`", { parse_mode: "Markdown" });
  } catch (e: any) { await ctx.reply(`❌ ${e.message}`); }
});

bot.command("ds", async (ctx) => {
  const chatId = ctx.chat.id;
  const state = chatStates.get(sessionKey(chatId));
  if (!state) { await ctx.reply("No active session."); return; }
  const registry = (state.session as any).modelRegistry;
  const model = registry.find("ollama", "deepseek-v4-pro:cloud");
  if (!model) { await ctx.reply("❌ DeepSeek V4 Pro not found in model registry."); return; }
  try {
    await state.session.setModel(model);
    await ctx.reply("✅ *DeepSeek V4 Pro* — `ollama/deepseek-v4-pro:cloud`", { parse_mode: "Markdown" });
  } catch (e: any) { await ctx.reply(`❌ ${e.message}`); }
});

bot.command("think", async (ctx) => {
  const chatId = ctx.chat.id;
  const state = chatStates.get(sessionKey(chatId));
  if (!state) { await ctx.reply("No active session."); return; }
  const current = (state.session as any).thinkingLevel ?? "high";
  const newLevel = current === "off" ? "high" : "off";
  (state.session as any).setThinkingLevel(newLevel);
  await ctx.reply(`🧠 Thinking: *${newLevel}* ${newLevel === "off" ? "🔇" : "🧠"}`, { parse_mode: "Markdown" });
});

bot.command("memory", async (ctx) => {
  const chatId = ctx.chat.id;
  const memory = readMemory(chatId);
  if (!memory) {
    await ctx.reply("🧠 No memory yet. I'll start building it as we talk.");
    return;
  }
  const chunks = splitMessage(`🧠 *My memory for this chat:*\n\n${memory}`);
  for (const chunk of chunks) await ctx.reply(chunk, { parse_mode: "Markdown" }).catch(() => ctx.reply(chunk));
});

bot.command("meet", handleMeetCommand);
bot.command("meeting", handleMeetCommand);
bot.command("meet-snapshot", handleMeetSnapshotCommand);
bot.command("booking", handleBookingCommand);
bot.command("calendar", handleBookingCommand);

bot.command("materials", async (ctx) => {
  const registry = loadAgentBuildMaterialsRegistry();
  if (!registry) {
    await ctx.reply(`Materials registry not found or invalid at:\n${MATERIALS_REGISTRY_PATH}`);
    return;
  }

  const materials = Array.isArray(registry.materials) ? registry.materials : [];
  if (!materials.length) {
    await ctx.reply("Materials registry is currently empty.");
    return;
  }

  const rawQuery = (ctx.message?.text || "").replace(/^\/materials(?:@\w+)?\s*/i, "").trim().toLowerCase();
  const categories = listUniqueMaterialCategories(materials);
  const confidenceValues = [...new Set(materials.map((m) => String(m.confidence || "").toLowerCase()))]
    .filter(Boolean)
    .sort();

  if (!rawQuery || rawQuery === "help") {
    const byCategory = categories
      .map((category) => `• ${category} (${materials.filter((m) => m.category.toLowerCase() === category).length})`)
      .join("\n");
    const byConfidence = confidenceValues
      .map((confidence) => `• ${confidence} (${materials.filter((m) => String(m.confidence || "").toLowerCase() === confidence).length})`)
      .join("\n");

    await ctx.reply(
      [
        "🧱 Agent Build Materials Library",
        `Updated: ${registry.updated_at || "unknown"}`,
        `Total materials: ${materials.length}`,
        "",
        "Categories:",
        byCategory || "(none)",
        "",
        "Confidence:",
        byConfidence || "(none)",
        "",
        "Usage:",
        "/materials <category>",
        "/materials <confidence>",
        "/materials <keyword>",
        "",
        "Examples:",
        "/materials scheduling",
        "/materials candidate",
        "/materials calendar",
      ].join("\n")
    );
    return;
  }

  let filtered: AgentBuildMaterial[] = [];
  const isCategory = categories.includes(rawQuery);
  const isConfidence = confidenceValues.includes(rawQuery);

  if (isCategory) {
    filtered = materials.filter((m) => m.category.toLowerCase() === rawQuery);
  } else if (isConfidence) {
    filtered = materials.filter((m) => String(m.confidence || "").toLowerCase() === rawQuery);
  } else {
    filtered = materials.filter((m) => materialSearchText(m).includes(rawQuery));
  }

  if (!filtered.length) {
    await ctx.reply(
      [
        `No materials found for: ${rawQuery}`,
        `Tip: try one of these categories: ${categories.join(", ") || "(none)"}`,
      ].join("\n")
    );
    return;
  }

  const shown = filtered.slice(0, 20);
  const header = `🧱 Materials results for "${rawQuery}" (${filtered.length} match${filtered.length === 1 ? "" : "es"}; showing ${shown.length})`;
  const body = shown.map((material, i) => formatMaterialEntry(material, i + 1)).join("\n\n");

  const chunks = splitMessage(`${header}\n\n${body}`);
  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
});

bot.command("brain", async (ctx) => {
  const chatId = ctx.chat.id;

  if (!isChowPrimaryChat(chatId)) {
    await ctx.reply("This command is only enabled for Chow primary chat memory lane.");
    return;
  }

  const raw = (ctx.message?.text || "").replace(/^\/brain(?:@\w+)?\s*/i, "").trim();
  const [sub, ...rest] = raw.split(/\s+/).filter(Boolean);
  const command = (sub || "help").toLowerCase();

  const help = [
    "🧠 Brain commands:",
    "/brain peek [n]",
    "/brain search <query>",
    "/brain add <note>",
    "/brain status",
    "/brain consolidate",
  ].join("\n");

  if (command === "help") {
    await ctx.reply(help);
    return;
  }

  if (command === "peek") {
    const n = Number(rest[0] || "8");
    const limit = Number.isFinite(n) ? Math.max(1, Math.min(20, Math.floor(n))) : 8;
    const events = listBrainEvents(chatId, limit);
    if (!events.length) {
      await ctx.reply("No structured events captured yet.");
      return;
    }
    const lines = events.map((event, i) => formatBrainEventLine(event, i));
    const chunks = splitMessage([`🧠 Recent events (${events.length})`, ...lines].join("\n"));
    for (const chunk of chunks) await ctx.reply(chunk);
    return;
  }

  if (command === "search") {
    const query = rest.join(" ").trim();
    if (!query) {
      await ctx.reply("Usage: /brain search <query>");
      return;
    }

    const results = searchBrainEvents(chatId, query, 10);
    if (!results.length) {
      await ctx.reply(`No memory hits for: ${query}`);
      return;
    }

    const lines = results.map((event, i) => `${formatBrainEventLine(event, i)} | score:${event.score}`);
    const chunks = splitMessage([`🔎 Brain search: ${query}`, ...lines].join("\n"));
    for (const chunk of chunks) await ctx.reply(chunk);
    return;
  }

  if (command === "add") {
    const note = rest.join(" ").trim();
    if (!note) {
      await ctx.reply("Usage: /brain add <note>");
      return;
    }

    const event = addManualBrainNote(chatId, note, "brain-command");
    if (!event) {
      await ctx.reply("Could not add note.");
      return;
    }

    logChowFeedback({
      chat_id: String(chatId),
      kind: "memory",
      project: "chow",
      user_request: `/brain add ${note}`,
      context_refs: ["brain-command"],
      chow_output: formatBrainEventLine(event),
      final_output: formatBrainEventLine(event),
      outcome: "accepted",
      quality: "good",
      reason_codes: ["manual_memory_note"],
      notes: "Explicit structured brain note added by operator.",
    });

    await ctx.reply(`✅ Saved\n${formatBrainEventLine(event)}`);
    return;
  }

  if (command === "status") {
    const status = getBrainStatus(chatId);
    const lines = [
      "🧠 Brain status",
      `Events: ${status.eventCount}`,
      `Last event: ${status.lastEventAt || "none"}`,
      `Last consolidated date: ${status.lastConsolidatedDate || "none"}`,
      `Latest consolidation: ${status.latestConsolidationPath || "none"}`,
    ];
    await ctx.reply(lines.join("\n"));
    return;
  }

  if (command === "consolidate") {
    const result = forceDailyBrainConsolidation(chatId, "brain-command");
    await ctx.reply(
      [
        "✅ Consolidation complete",
        `Date: ${result.date}`,
        `Events: ${result.eventCount}`,
        `File: ${result.path}`,
      ].join("\n")
    );
    return;
  }

  await ctx.reply(help);
});

bot.command("brief", async (ctx) => {
  const text = getJoseTriageText("brief");
  const chunks = splitMessage(text);
  for (const chunk of chunks) await ctx.reply(chunk);
});

bot.command("urgent", async (ctx) => {
  const text = getJoseTriageText("urgent");
  const chunks = splitMessage(text);
  for (const chunk of chunks) await ctx.reply(chunk);
});

bot.command("topics", async (ctx) => {
  const text = getJoseTriageText("topics");
  const chunks = splitMessage(text);
  for (const chunk of chunks) await ctx.reply(chunk);
});

bot.command("events", async (ctx) => {
  const text = getJoseRecentEventsText();
  const chunks = splitMessage(text);
  for (const chunk of chunks) await ctx.reply(chunk);
});

bot.command("ask", async (ctx) => {
  const query = ctx.message?.text?.replace(/^\/ask\s*/i, "").trim();
  const text = getJoseTriageText("ask", query);
  const chunks = splitMessage(text);
  for (const chunk of chunks) await ctx.reply(chunk);
});

// ─── /work — background long-running agent ───────────────────────────────────

function loadProjects(): Record<string, string> {
  const p = path.join(process.cwd(), "projects.json");
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}

function detectProject(task: string): { name: string; projectPath: string } {
  const projects = loadProjects();
  const taskLower = task.toLowerCase();
  for (const [key, projectPath] of Object.entries(projects)) {
    if (taskLower.includes(key.toLowerCase())) {
      return { name: key, projectPath };
    }
  }
  // Default: Chow's own bot directory
  return { name: "workspace", projectPath: process.cwd() };
}

function spawnBackgroundAgent(taskId: string, project: string, projectPath: string, task: string, chatId: number): void {
  const botRoot = process.cwd();
  const child = spawn(
    "npx", ["tsx", "src/agent-runner.ts",
      "--task-id", taskId,
      "--project", project,
      "--project-path", projectPath,
      "--task", task,
      "--chat-id", String(chatId),
    ],
    {
      cwd: botRoot,
      detached: true,
      stdio: ["ignore", fs.openSync(path.join(botRoot, "agent-sessions", `${taskId}.log`), "a"), "pipe"],
      env: process.env,
    }
  );
  child.unref();
}

bot.command("work", async (ctx) => {
  if (!isAllowed(ctx.chat.id)) { await ctx.reply("⛔ Not authorized."); return; }

  const rawText = ctx.message?.text?.replace(/^\/work\s*/i, "").trim() ?? "";
  if (!rawText) {
    await ctx.reply(
      "🚀 *Usage:* `/work <task description>`\n\n" +
      "Example:\n`/work fix the login bug in coworkers site`\n`/work add dark mode to the dashboard`\n\n" +
      "I'll run in the background and ping you when done. You can sleep — I won't.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const chatId = ctx.chat.id;
  const { name: project, projectPath } = detectProject(rawText);

  // Create task record
  fs.mkdirSync(path.join(process.cwd(), "agent-sessions"), { recursive: true });
  const task = createTask({
    chatId,
    project,
    projectPath,
    description: rawText,
    tmuxSession: "",
  });

  logChowFeedback({
    chat_id: String(chatId),
    kind: "task",
    project,
    user_request: rawText,
    context_refs: [projectPath, `task:${task.id}`],
    chow_output: `Spawned background task ${task.id}`,
    final_output: `Spawned background task ${task.id}`,
    outcome: "accepted",
    quality: "good",
    reason_codes: ["background_task_started"],
    notes: `Project=${project}`,
  });

  // Spawn detached background agent
  spawnBackgroundAgent(task.id, project, projectPath, rawText, chatId);

  await ctx.reply(
    `🚀 *Task started* \`${task.id}\`\n` +
    `Project: *${project}*\n` +
    `Path: \`${projectPath}\`\n\n` +
    `_${rawText.slice(0, 120)}_\n\n` +
    `I'll ping you every 5 min while working and when done. Go sleep 😴\n` +
    `/active to check status`,
    { parse_mode: "Markdown" }
  );
});

bot.command("active", async (ctx) => {
  if (!isAllowed(ctx.chat.id)) return;
  const running = listTasks("running");
  if (!running.length) {
    await ctx.reply("💤 No active background tasks.");
    return;
  }
  const lines = running.map((t) => {
    const elapsed = Math.round((Date.now() - new Date(t.startedAt).getTime()) / 1000 / 60);
    return `• \`${t.id}\` *${t.project}* — ${elapsed}m\n  _${t.description.slice(0, 60)}_`;
  });
  await ctx.reply(`⚙️ *Active tasks (${running.length}):*\n\n${lines.join("\n\n")}`, { parse_mode: "Markdown" });
});

bot.command("cancel", async (ctx) => {
  if (!isAllowed(ctx.chat.id)) return;
  const taskId = ctx.message?.text?.replace(/^\/cancel\s*/i, "").trim();
  if (!taskId) {
    const running = listTasks("running");
    if (!running.length) { await ctx.reply("No active tasks."); return; }
    await ctx.reply(`Specify task id: /cancel ${running[0].id}`);
    return;
  }
  updateTaskRecord(taskId, { status: "cancelled", finishedAt: new Date().toISOString(), summary: "Cancelled by user" });
  await ctx.reply(`🛑 Marked \`${taskId}\` as cancelled. (Background process may still be running briefly)`, { parse_mode: "Markdown" });
});

bot.command("review", async (ctx) => {
  if (!isAllowed(ctx.chat.id)) return;
  const taskId = ctx.message?.text?.replace(/^\/review\s*/i, "").trim();
  if (!taskId) {
    const recent = listTasks().slice(-5).reverse();
    const lines = recent.map((t) => `• \`${t.id}\` [${t.status}] *${t.project}* — _${t.description.slice(0, 50)}_`);
    await ctx.reply(`📋 *Recent tasks:*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
    return;
  }
  const output = readOutput(taskId);
  if (!output) {
    await ctx.reply(`No output found for \`${taskId}\`. Still running?`, { parse_mode: "Markdown" });
    return;
  }
  const chunks = splitMessage(`📄 *Output: ${taskId}*\n\n${output}`);
  for (const chunk of chunks) await ctx.reply(chunk, { parse_mode: "Markdown" }).catch(() => ctx.reply(chunk));
});

// Text messages → pi (fire & forget so Telegraf's 90s handler timeout doesn't kill us)
bot.on(message("text"), (ctx) => {
  const chatId = ctx.chat.id;
  const user = ctx.from?.username ?? ctx.from?.first_name ?? String(chatId);
  const text = ctx.message.text;
  // Debug: log ALL incoming messages including from bots
  console.log(`[DEBUG-MSG] from_id=${ctx.from?.id} is_bot=${ctx.from?.is_bot} username=${ctx.from?.username} chat=${chatId} text=${text.slice(0,80)}`);

  // Group filter: only respond if mentioned, replied to, or from a known bot peer
  if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
    const botUsername = `@${ctx.botInfo?.username}`;
    const botId = ctx.botInfo?.id;
    const lowerText = text.toLowerCase();
    const isMentioned = lowerText.includes(botUsername?.toLowerCase()) || 
                       (ctx.message as any).entities?.some((e: any) => 
                         (e.type === "mention" && lowerText.slice(e.offset, e.offset + e.length) === botUsername?.toLowerCase()) ||
                         (e.type === "text_mention" && e.user?.id === botId)
                       );
    const isReplyToMe = (ctx.message as any).reply_to_message?.from?.id === botId;

    // Bot-to-Bot Communication: allow messages from known bot peers through
    const fromId = ctx.from?.id;
    const fromUsername = (ctx.from?.username ?? "").toLowerCase();
    const isKnownBotPeer = KNOWN_BOT_PEERS.has(fromId!)
      || fromId === 8290119968 // @Hog_hector_bot
      || KNOWN_BOT_PEER_PATTERNS.some(p => fromUsername.includes(p));

    const shouldAutoJoinHumanGroupChat = GROUP_RESPOND_WITHOUT_TAG && !ctx.from?.is_bot;
    console.log(`[GROUP-FILTER] chat=${chatId} from=@${fromUsername}(${fromId}) is_bot=${ctx.from?.is_bot} mentioned=${isMentioned} replyToMe=${isReplyToMe} peer=${isKnownBotPeer} autoHuman=${shouldAutoJoinHumanGroupChat} text="${text.slice(0,60)}"`);
    if (!isMentioned && !isReplyToMe && !isKnownBotPeer && !shouldAutoJoinHumanGroupChat) return;
    console.log(`[GROUP-FILTER] PASSED - processing message`);

    // Anti-loop: rate limit bot-to-bot exchanges
    if (ctx.from?.is_bot && isKnownBotPeer) {
      const now = Date.now();
      const key = String(chatId);
      const ts = botToBotTimestamps.get(key) ?? [];
      const recent = ts.filter(t => now - t < 60000); // last 60s
      if (recent.length >= BOT_TO_BOT_MAX_PER_MIN) {
        console.log(`[ANTI-LOOP] Skipping bot-to-bot reply in chat ${chatId}: rate limit hit (${recent.length} in last 60s)`);
        return;
      }
      if (recent.length >= BOT_TO_BOT_MAX_DEPTH) {
        console.log(`[ANTI-LOOP] Skipping bot-to-bot reply in chat ${chatId}: depth limit hit (${recent.length} exchanges)`);
        return;
      }
      recent.push(now);
      botToBotTimestamps.set(key, recent);
    }
  }

  console.log(`[${new Date().toISOString()}] @${user} (${chatId}): ${text.slice(0, 80)}`);

  // Run async in background — don't await
  getOrCreateSession(chatId)
    .then(() => runPiPrompt(ctx, chatId, text, user))
    .catch((err) => {
      console.error(`[ERROR] chatId=${chatId}:`, err?.message ?? err, err?.stack ?? "");
      ctx.reply(`❌ Error: ${err?.message ?? "Unknown error"}`).catch(() => {});
    });
});

// Photo messages → cache highest-res file then pass path into prompt context
bot.on(message("photo"), (ctx) => {
  const chatId = ctx.chat.id;
  const caption = String((ctx.message as any)?.caption ?? "").trim();
  const photos = ((ctx.message as any)?.photo ?? []) as Array<{ file_id?: string; width?: number; height?: number }>;
  const photo = photos.length ? photos[photos.length - 1] : undefined;
  const fileId = String(photo?.file_id ?? "");

  if (!fileId) {
    ctx.reply("Couldn't read photo file id. Please retry.").catch(() => {});
    return;
  }

  const active = chatStates.get(sessionKey(chatId));
  if (active?.busy) {
    ctx.reply("⏳ I’m still finishing the previous task. Please resend this photo in ~10s so I can process the latest one cleanly.").catch(() => {});
    return;
  }

  getOrCreateSession(chatId)
    .then(async () => {
      console.log(`[media] photo received chat=${chatId} fileId=${fileId.slice(0, 14)}... captionLen=${caption.length}`);
      const cached = await cacheTelegramFile(ctx, chatId, fileId, "photo.jpg");
      console.log(`[media] photo cached chat=${chatId} path=${cached.localPath} size=${cached.size}`);
      const prompt = [
        "[User sent a photo]",
        `Telegram file_id: ${fileId}`,
        `Telegram message_id: ${(ctx.message as any)?.message_id ?? "unknown"}`,
        caption ? `Caption: ${caption}` : "Caption: (none)",
        `Cached file path: ${cached.localPath}`,
        `Mime: ${cached.mimeType}; Size: ${cached.size} bytes`,
        "IMPORTANT: This is the latest uploaded image. Ignore prior image files unless user explicitly asks to compare.",
        "If you need to inspect exact image contents, use this cached file path.",
      ].join("\n");
      await runPiPrompt(ctx, chatId, prompt);
    })
    .catch((err) => {
      ctx.reply(`❌ Error: ${err?.message ?? "Unknown error"}`).catch(() => {});
    });
});

// Document/file uploads → cache file and pass path into prompt context
bot.on(message("document"), (ctx) => {
  const chatId = ctx.chat.id;
  const doc = (ctx.message as any)?.document as {
    file_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  } | undefined;

  const fileId = String(doc?.file_id ?? "");
  const fileName = String(doc?.file_name ?? "upload.bin");
  const declaredMime = String(doc?.mime_type ?? "application/octet-stream");
  const declaredSize = Number(doc?.file_size ?? 0);
  const caption = String((ctx.message as any)?.caption ?? "").trim();

  if (!fileId) {
    ctx.reply("Couldn't read document file id. Please retry.").catch(() => {});
    return;
  }

  const active = chatStates.get(sessionKey(chatId));
  if (active?.busy) {
    ctx.reply("⏳ I’m still finishing the previous task. Please resend this file in ~10s so I can process the newest upload cleanly.").catch(() => {});
    return;
  }

  getOrCreateSession(chatId)
    .then(async () => {
      console.log(`[media] document received chat=${chatId} fileId=${fileId.slice(0, 14)}... fileName=${fileName}`);
      const cached = await cacheTelegramFile(ctx, chatId, fileId, fileName);
      console.log(`[media] document cached chat=${chatId} path=${cached.localPath} size=${cached.size}`);
      const prompt = [
        "[User sent a file]",
        `Telegram file_id: ${fileId}`,
        `Telegram message_id: ${(ctx.message as any)?.message_id ?? "unknown"}`,
        caption ? `Caption: ${caption}` : "Caption: (none)",
        `Filename: ${fileName}`,
        `Declared mime: ${declaredMime}; Declared size: ${declaredSize || "unknown"}`,
        `Cached file path: ${cached.localPath}`,
        `Detected mime: ${cached.mimeType}; Downloaded size: ${cached.size} bytes`,
        "IMPORTANT: This is the latest uploaded file. Ignore prior file paths unless user explicitly asks to compare.",
        "Use this exact cached file path for analysis.",
      ].join("\n");
      await runPiPrompt(ctx, chatId, prompt);
    })
    .catch((err) => {
      ctx.reply(`❌ Error: ${err?.message ?? "Unknown error"}`).catch(() => {});
    });
});

// Voice notes / audio clips → transcribe then run through normal prompt flow
async function handleAudioInput(
  ctx: Context,
  fileId: string,
  fileName: string,
  mimeType: string,
  senderName: string
): Promise<void> {
  const chatId = ctx.chat!.id;

  if (!VOICE_ENABLED) {
    await ctx.reply(
      "🎙️ Voice transcription is not enabled yet. Set GEMINI_API_KEY (or OPENAI_API_KEY fallback) and restart."
    );
    return;
  }

  const busyState = chatStates.get(sessionKey(chatId));
  if (busyState?.busy) {
    await ctx.reply("⏳ Still working on the previous request. Send /abort to cancel.");
    return;
  }

  const statusMsg = await ctx.reply("🎙️ Voice received — transcribing...");

  try {
    const transcript = await transcribeTelegramAudio(ctx, fileId, fileName, mimeType);
    const preview = transcript.length > 220 ? `${transcript.slice(0, 220)}...` : transcript;

    await safeEdit(
      ctx,
      statusMsg.message_id,
      `📝 Transcribed${preview ? `:\n${preview}` : "."}\n\n🤔 Thinking...`
    );

    await getOrCreateSession(chatId);
    await runPiPrompt(ctx, chatId, `[Voice transcript from ${senderName}]\n${transcript}`, senderName);
  } catch (err: any) {
    const errText = `❌ Voice transcription failed: ${err?.message ?? "Unknown error"}`;
    try {
      await safeEdit(ctx, statusMsg.message_id, errText);
    } catch {
      await ctx.reply(errText).catch(() => {});
    }
  }
}

bot.on(message("voice"), (ctx) => {
  const voice = (ctx.message as any)?.voice;
  const fileId = String(voice?.file_id ?? "");
  if (!fileId) {
    ctx.reply("Couldn't read voice file id. Please retry.").catch(() => {});
    return;
  }

  const sender = ctx.from?.username ?? ctx.from?.first_name ?? String(ctx.chat.id);
  void handleAudioInput(ctx, fileId, "voice.ogg", "audio/ogg", sender);
});

bot.on(message("audio"), (ctx) => {
  const audio = (ctx.message as any)?.audio;
  const fileId = String(audio?.file_id ?? "");
  if (!fileId) {
    ctx.reply("Couldn't read audio file id. Please retry.").catch(() => {});
    return;
  }

  const sender = ctx.from?.username ?? ctx.from?.first_name ?? String(ctx.chat.id);
  const mimeType = String(audio?.mime_type ?? "audio/mpeg");
  const fileName = String(audio?.file_name ?? "audio-upload");
  void handleAudioInput(ctx, fileId, fileName, mimeType, sender);
});

// Global error handler — log but don't crash
bot.catch((err, ctx) => {
  console.error(`[BOT ERROR] chat=${ctx.chat?.id}:`, (err as any)?.message ?? err);
});

let botRunning = false;
let shuttingDown = false;
let brainDailyTimer: ReturnType<typeof setInterval> | null = null;

async function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Shutting down (${signal})...`);
  if (hiveRuntime) {
    try {
      hiveRuntime.disconnect();
    } catch (err) {
      console.error(`[shutdown] hive runtime disconnect failed:`, (err as any)?.message ?? err);
    }
    hiveRuntime = null;
  }

  if (brainDailyTimer) {
    clearInterval(brainDailyTimer);
    brainDailyTimer = null;
  }
  for (const [, state] of chatStates) {
    try {
      state.session.dispose();
    } catch (err) {
      console.error(`[shutdown] session dispose failed:`, (err as any)?.message ?? err);
    }
  }

  if (botRunning) {
    try {
      bot.stop(signal);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      if (!message.includes("Bot is not running")) {
        console.error(`[shutdown] bot.stop failed:`, message);
      }
    }
    botRunning = false;
  }

  process.exit(0);
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

// ─── Launch ───────────────────────────────────────────────────────────────────

console.log("🤖 Pi Telegram Bot starting...");
const hiveConnectPromise = HIVE_ENABLED
  ? connectHiveLoop().catch((error: any) => {
      console.error(`[hive] connect failed:`, error?.message ?? error);
    })
  : Promise.resolve();
await bot.launch();
botRunning = true;
startBrainDailyScheduler();
await hiveConnectPromise;
console.log(`✅ ${BOT_NAME} is running! Relay: ${isRelayEnabled() ? process.env.RELAY_URL : "disabled"} | Hive: ${HIVE_ENABLED ? HIVE_WS_URL : "disabled"}`);
