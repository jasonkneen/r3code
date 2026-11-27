// Shiki coverage for chat code blocks (reference MarkdownCodeBlock.tsx:270-372 highlights every
// fence with Shiki). t3ui bundles Shiki 4.2.0 with its JavaScript regex engine and all 332 bundled
// grammars as t3ui/vendor/shiki/shiki.js (built from entry.mjs.txt). A grammar is parsed on the
// first block in its language (a few ms); fences Shiki has no grammar for, or a tokenizer error,
// fall back to the regex highlighter (highlight.ts). Colours are pierre-light / pierre-dark; light
// colours are darkened like the reference's t3-light theme (lib/readableSyntaxTheme.ts).
import { host, platform, signal } from "nsh";
// @ts-ignore vendored build without types
import { shikiHasLanguage, shikiLoadLanguageSync, shikiTokens, shikiTokensFromState } from "../../../vendor/shiki/shiki.js";
import { highlightCode, type HighlightToken } from "./highlight";
import { msSinceUserInput } from "../../userActivity";

export interface ShikiToken extends HighlightToken {
  /** Theme colour for the current scheme; absent on regex-fallback tokens. */
  color?: string;
  italic?: boolean;
  bold?: boolean;
  underline?: boolean;
}

/** Fence info / file name to the Shiki grammar id, or null when Shiki has none. */
export function resolveShikiLanguage(info: string | null | undefined): string | null {
  if (!info) return null;
  let value = info.trim().toLowerCase().replace(/^language-/, "").split(/\s+/)[0] ?? "";
  value = value.split("{")[0] ?? "";
  if (!value) return null;
  if (shikiHasLanguage(value)) return value;
  const base = value.split("/").pop() ?? value;
  if (shikiHasLanguage(base)) return base;
  const dot = base.lastIndexOf(".");
  if (dot >= 0 && shikiHasLanguage(base.slice(dot + 1))) return base.slice(dot + 1);
  return null;
}

const MIN_CONTRAST = 4.5;
const DARKEST_SURFACE_LUMINANCE = 0.69;
const FURTHER_COLORS = new Set(["#1ca1c7", "#636363", "#1a85d4"]);
function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
function contrastOnLightCode(rgb: number[]): number {
  const [r, g, b] = rgb.map(channelLuminance) as [number, number, number];
  return (DARKEST_SURFACE_LUMINANCE + 0.05) / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}
const readableCache = new Map<string, string>();
/** Port of readableSyntaxColor: a pierre-light colour darkened until it reads on light code. */
export function readableSyntaxColor(color: string): string {
  const cached = readableCache.get(color);
  if (cached) return cached;
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  let out = color;
  if (match) {
    const min = FURTHER_COLORS.has(color.toLowerCase()) ? 6 : MIN_CONTRAST;
    let rgb = [0, 2, 4].map((start) => Number.parseInt(match[1]!.slice(start, start + 2), 16));
    if (contrastOnLightCode(rgb) < min) {
      while (contrastOnLightCode(rgb) < min) rgb = rgb.map((channel) => Math.floor(channel * 0.96));
      out = `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}${match[2] ?? ""}`;
    }
  }
  readableCache.set(color, out);
  return out;
}

const warm = new Set<string>();
// A few common constructs, so warming compiles most of a grammar's hot regexes up front.
const WARM_SAMPLE = 'import { a } from "b";\nexport const x: number = 1 + f(2); // c\nfunction g(y) { return `t${y}` }\nif [ -n "$X" ]; then echo hi; fi\n<div class="a">t</div>\n';
const revision = signal(0);
type RawLine = [string, string | null, string | null, number][];
const tokenCache = new Map<string, RawLine[]>();

// No worker API in nsh, so a grammar build (TypeScript ~330 ms, one blocking JS turn) runs only after IDLE_MS without
// input, one grammar per turn with a frame between, and readers swap to Shiki colours through `revision`. Until then
// the regex highlighter draws the block.
export const SHIKI_IDLE_MS = 2000;
const BETWEEN_BUILDS_MS = 32;
/** The languages built at the first idle moment after startup (ts, js, tsx, json, bash, python, md). */
export const SHIKI_PREWARM = ["ts", "js", "tsx", "json", "bash", "python", "md"];
const queue: string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

function schedule(delay: number) {
  if (timer !== undefined) return;
  timer = setTimeout(() => { timer = undefined; buildNext(); }, delay);
}

function buildNext() {
  while (queue.length > 0 && warm.has(queue[0]!)) queue.shift();
  if (queue.length === 0) return;
  const quiet = msSinceUserInput();
  if (quiet < SHIKI_IDLE_MS) { schedule(SHIKI_IDLE_MS - quiet); return; }
  const id = queue.shift()!;
  warmLanguage(id);
  revision.set(revision() + 1);
  if (queue.length > 0) schedule(BETWEEN_BUILDS_MS);
}

function warmLanguage(id: string): boolean {
  let ok = false;
  try { ok = Boolean(shikiLoadLanguageSync(id)); } catch { ok = false; }
  if (ok) { try { shikiTokens(WARM_SAMPLE, id); } catch { /* falls back per block */ } }
  // A grammar that failed stays "warm" too, so it is not retried; rawTokens then falls back to the regex highlighter.
  warm.add(id);
  return ok;
}

function requestBuild(id: string) {
  if (warm.has(id) || queue.includes(id)) return;
  queue.push(id);
  schedule(Math.max(BETWEEN_BUILDS_MS, SHIKI_IDLE_MS - msSinceUserInput()));
}

/** Startup settles for this long before the prewarm queues (then each build still waits for SHIKI_IDLE_MS of quiet). */
export const SHIKI_PREWARM_DELAY_MS = 10_000;
/** Queues the common grammars for idle-time builds (called once after startup). */
export function prewarmShikiLanguages(ids: readonly string[] = SHIKI_PREWARM, delay = SHIKI_PREWARM_DELAY_MS) {
  setTimeout(() => { for (const info of ids) { const id = resolveShikiLanguage(info); if (id) requestBuild(id); } }, delay);
}

/** Whether a grammar is built (test seam). */
export const shikiLanguageWarm = (id: string) => warm.has(id);

// Tokenizing is slow too (TypeScript ~8 ms a line here), so a block is tokenized a few lines per JS turn, carrying the
// grammar state across turns. Its lines swap from the regex highlighter's colours to Shiki's as they come in, and every
// line keeps its array between calls so a redraw rebuilds only the lines that changed.
const SLICE_MS = 12;
const SYNC_LINES = 3;
interface TokenJob { key: string; id: string; lines: string[]; done: RawLine[]; state: unknown; }
const jobs = new Map<string, TokenJob>();
// Each pending block redraws alone as its lines come in (a global revision would redraw every block).
const pendingReaders = new Map<string, ReturnType<typeof signal<number>>>();
let pumpTimer: ReturnType<typeof setTimeout> | undefined;

function pump() {
  pumpTimer = undefined;
  const started = Date.now();
  const progressed = new Set<string>();
  while (jobs.size > 0 && Date.now() - started < SLICE_MS) {
    const job = jobs.values().next().value as TokenJob;
    let result: { lines: RawLine[]; state: unknown } | null = null;
    try { result = shikiTokensFromState(job.lines[job.done.length]!, job.id, job.state); } catch { result = null; }
    if (!result) { jobs.delete(job.key); progressed.add(job.key); continue; }
    job.done.push(result.lines[0] ?? []);
    job.state = result.state;
    progressed.add(job.key);
    if (job.done.length === job.lines.length) { remember(job.key, job.done); jobs.delete(job.key); }
  }
  for (const key of progressed) {
    const reader = pendingReaders.get(key);
    if (reader) reader.set((reader() ?? 0) + 1);
    if (!jobs.has(key)) pendingReaders.delete(key);
  }
  if (jobs.size > 0) pumpTimer = setTimeout(pump, 4);
}

function tokenCacheLimit(): number {
  try { return platform.os === "windows" ? 64 : 128; } catch { return 128; }
}
function lineCacheLimit(): number {
  try { return platform.os === "windows" ? 128 : 512; } catch { return 512; }
}

function remember(key: string, lines: RawLine[]) {
  tokenCache.delete(key);
  tokenCache.set(key, lines);
  if (tokenCache.size > tokenCacheLimit()) tokenCache.delete(tokenCache.keys().next().value as string);
}

/** The block's Shiki lines so far (all of them once done), or null when Shiki cannot tokenize it. */
function rawTokens(code: string, id: string, key: string): RawLine[] | null {
  const cached = tokenCache.get(key);
  if (cached) return cached;
  const lines = code.split("\n");
  if (lines.length <= SYNC_LINES) {
    let out: RawLine[] | null = null;
    try { out = shikiLoadLanguageSync(id) ? shikiTokens(code, id) : null; } catch { out = null; }
    if (out) remember(key, out);
    return out;
  }
  let job = jobs.get(key);
  if (!job) {
    job = { key, id, lines, done: [], state: null };
    jobs.set(key, job);
    if (pumpTimer === undefined) pumpTimer = setTimeout(pump, 0);
  }
  let reader = pendingReaders.get(key);
  if (!reader) { reader = signal(0); pendingReaders.set(key, reader); }
  reader();
  return job.done;
}

// Stable line arrays: the regex lines of a block, and its converted Shiki lines per scheme.
const regexLines = new Map<string, ShikiToken[][]>();
const shikiLines = new Map<string, (ShikiToken[] | undefined)[]>();
function bounded<T>(map: Map<string, T>, key: string, make: () => T): T {
  let value = map.get(key);
  if (value === undefined) { value = make(); map.set(key, value); if (map.size > lineCacheLimit()) map.delete(map.keys().next().value as string); }
  return value;
}

function convert(line: RawLine, scheme: "light" | "dark"): ShikiToken[] {
  return line.map(([text, light, dark, style]) => {
    const raw = scheme === "dark" ? dark : light;
    const token: ShikiToken = { text, kind: "plain" };
    if (raw) token.color = scheme === "dark" ? raw : readableSyntaxColor(raw);
    if (style & 1) token.italic = true;
    if (style & 2) token.bold = true;
    if (style & 4) token.underline = true;
    return token;
  });
}

const NATIVE_MISSED_TTL_MS = 15_000;
const NATIVE_MISSED_LIMIT = 128;
const nativePending = new Set<string>();
const nativeMissed = new Map<string, number>();

function rememberNativeMissed(key: string): void {
  nativeMissed.delete(key);
  nativeMissed.set(key, Date.now() + NATIVE_MISSED_TTL_MS);
  while (nativeMissed.size > NATIVE_MISSED_LIMIT) {
    nativeMissed.delete(nativeMissed.keys().next().value as string);
  }
}

function isNativeMissed(key: string): boolean {
  const until = nativeMissed.get(key);
  if (until === undefined) return false;
  if (until <= Date.now()) {
    nativeMissed.delete(key);
    return false;
  }
  return true;
}

function useNativeHighlight(): boolean {
  try { return platform.os === "windows" && host.available(); } catch { return false; }
}

function nativeTokens(code: string, id: string, key: string): RawLine[] | null {
  const cached = tokenCache.get(key);
  if (cached) return cached;
  if (isNativeMissed(key)) return null;
  let reader = pendingReaders.get(key);
  if (!reader) { reader = signal(0); pendingReaders.set(key, reader); }
  reader();
  if (!nativePending.has(key)) {
    nativePending.add(key);
    void host.call("r3.highlight", { lang: id, code }, { timeout: 10_000 }).then((result) => {
      nativePending.delete(key);
      if (Array.isArray(result)) {
        remember(key, result as RawLine[]);
      } else {
        rememberNativeMissed(key);
      }
      const next = pendingReaders.get(key);
      pendingReaders.delete(key);
      if (next) next.set((next() ?? 0) + 1);
    }).catch(() => {
      nativePending.delete(key);
      rememberNativeMissed(key);
      pendingReaders.delete(key);
    });
  }
  return null;
}

/**
 * Tokens for a code block: Shiki's once its grammar is built (line by line as they are tokenized), else the regex
 * highlighter's. A missing grammar is queued for an idle-time build (see buildNext).
 * Each line's token text concatenates to the source line.
 */
export function highlightCodeShiki(code: string, info: string | null | undefined, scheme: "light" | "dark"): ShikiToken[][] {
  revision();
  const id = resolveShikiLanguage(info);
  const regex = () => bounded(regexLines, `${info ?? ""}\u0000${code}`, () => highlightCode(code, info));
  if (!id) return regex();
  const key = `${id}\u0000${code}`;
  let raw: RawLine[] | null;
  if (useNativeHighlight()) {
    raw = nativeTokens(code, id, key);
  } else {
    if (!warm.has(id)) { requestBuild(id); return regex(); }
    raw = rawTokens(code, id, key);
  }
  if (!raw) return regex();
  const converted = bounded(shikiLines, `${scheme}\u0000${key}`, () => []);
  for (let index = 0; index < raw.length; index++) if (!converted[index]) converted[index] = convert(raw[index]!, scheme);
  const fallback = raw.length < code.split("\n").length ? regex() : null;
  // Mixing needs the regex lines to line up with the source lines; otherwise the block waits for all of Shiki's.
  if (fallback && fallback.length !== code.split("\n").length) return fallback;
  const count = fallback ? fallback.length : raw.length;
  const out: ShikiToken[][] = new Array(count);
  for (let index = 0; index < count; index++) out[index] = (index < raw.length ? converted[index] : fallback![index])!;
  return out;
}

/** Builds a Shiki grammar now, blocking (fixtures and tests; the app builds them at idle). */
export function loadShikiLanguage(id: string): boolean {
  if (warm.has(id)) { try { return Boolean(shikiLoadLanguageSync(id)); } catch { return false; } }
  const ok = warmLanguage(id);
  revision.set(revision() + 1);
  return ok;
}
