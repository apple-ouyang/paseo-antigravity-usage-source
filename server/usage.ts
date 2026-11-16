/**
 * Antigravity CLI (agy) quota for the Paseo usage panel.
 *
 * `agy` keeps its own quota view, and print mode exposes it without touching a
 * conversation: `agy -p "/quota"` prints one tab-separated line per window:
 *
 *   Gemini Models<TAB>Weekly Limit Remaining<TAB>13%<TAB>2026-11-13T23:43:48Z
 *   Gemini Models<TAB>Five Hour Limit Remaining<TAB>90%<TAB>2026-11-10T10:33:10Z
 *   Claude and GPT models<TAB>Weekly Limit Remaining<TAB>26%<TAB>...
 *   Claude and GPT models<TAB>Five Hour Limit Remaining<TAB>56%<TAB>...
 *
 * The CLI refreshes that view through its own authenticated backend, so reading
 * the printed report needs no token handling here. The numbers are *remaining*
 * percentages; the panel wants used.
 *
 * The call spawns the CLI (measured ~7s cold) and creates no conversation, so it
 * runs only on a panel refresh; the daemon caches reports for five minutes.
 */
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageAccount,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import type { AgyUsageInput } from "../shared/input.ts";

/** The daemon drops a source's fetch at 20s; stay inside it so a slow CLI still reports. */
const FETCH_TIMEOUT_MS = 18_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** `agy -p "/quota"` costs a CLI boot (~6s), so the panel reads this cache and a timer refreshes it. */
export const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
/** Past this age a fetch returns the last value but kicks off a refresh in the background. */
const BACKGROUND_REFRESH_AFTER_MS = 5 * 60 * 1000;
/** Past this age the fetch waits for a live CLI run; older than this the numbers are worthless. */
const MAX_REPORT_AGE_MS = 60 * 60 * 1000;

interface QuotaLine {
  group: string;
  label: string;
  remainingPct: number;
  resetsAt: string | null;
}

interface QuotaGroup {
  key: string;
  label: string;
}

function sanitizeKeyText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Collapse agy's model groups into the short names the panel shows. */
function groupFor(raw: string): QuotaGroup {
  const text = raw.trim();
  if (/gemini/i.test(text)) return { key: "gemini", label: "Gemini" };
  if (/claude/i.test(text) && /gpt/i.test(text)) return { key: "claude-gpt", label: "Claude/GPT" };
  if (/claude/i.test(text)) return { key: "claude", label: "Claude" };
  if (/gpt/i.test(text)) return { key: "gpt", label: "GPT" };
  return { key: sanitizeKeyText(text) || "quota", label: text || "Quota" };
}

/** Only the two window kinds agy prints today; anything new keeps a stable slug. */
function windowKindFor(label: string): { key: string; label: string; short: string; order: number } {
  if (/five[ _-]?hour|5[ _-]?hour|5h/i.test(label)) {
    return { key: "five-hour", label: "5-hour", short: "5h", order: 0 };
  }
  if (/week|weekly/i.test(label)) {
    return { key: "weekly", label: "Weekly", short: "wk", order: 1 };
  }
  if (/day|daily/i.test(label)) {
    return { key: "daily", label: "Daily", short: "day", order: 0 };
  }
  const key = sanitizeKeyText(label) || "window";
  return { key, label: label || "Limit", short: "", order: 2 };
}

function isoOrNull(value: string): string | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Exported for the fixture test: parse `agy -p "/quota"` stdout. */
export function parseQuotaOutput(stdout: string): QuotaLine[] {
  const lines: QuotaLine[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const parts = raw.split("\t").map((part) => part.trim());
    if (parts.length < 3) continue;
    const [group, label, percentText, resetText] = parts;
    if (!group || !label || !percentText) continue;
    const match = /(-?\d+(?:\.\d+)?)\s*%/.exec(percentText);
    if (!match?.[1]) continue;
    const remainingPct = Number(match[1]);
    if (!Number.isFinite(remainingPct)) continue;
    lines.push({
      group,
      label,
      remainingPct: Math.min(100, Math.max(0, remainingPct)),
      resetsAt: resetText ? isoOrNull(resetText) : null,
    });
  }
  return lines;
}

function quotaWindows(lines: QuotaLine[]): UsageWindow[] {
  const ordered = [...lines].sort((a, b) => {
    const left = windowKindFor(a.label).order;
    const right = windowKindFor(b.label).order;
    if (left !== right) return left - right;
    return a.group.localeCompare(b.group);
  });
  const windows: UsageWindow[] = [];
  for (const line of ordered) {
    const group = groupFor(line.group);
    const kind = windowKindFor(line.label);
    const usedPct = 100 - line.remainingPct;
    windows.push(
      windowFromUsedPct({
        id: `${group.key}:${kind.key}`,
        label: `${group.label} ${kind.label.toLowerCase()}`,
        shortLabel: `${group.label === "Gemini" ? "Gm" : group.label === "Claude/GPT" ? "C/G" : group.key} ${kind.short}`,
        // The 5-hour window is what throttles today's work; the weekly one follows it.
        summary: kind.key === "five-hour",
        utilizationPct: usedPct,
        resetsAt: line.resetsAt,
        tone: toneFromUsedPct(usedPct),
      }),
    );
  }
  return windows;
}

function binaryCandidates(): string[] {
  const home = homedir();
  const candidates = [
    process.env.AGY_BIN,
    join(home, ".local", "bin", "agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
  ];
  return candidates.filter((value): value is string => typeof value === "string" && value.length > 0);
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function accountFor(input: AgyUsageInput): UsageAccount {
  return {
    key: `agy-${hashAccountKey(input.path)}`,
    label: "Antigravity CLI",
    harness: "antigravity-cli",
    input,
  };
}

export async function discover(): Promise<UsageAccount[]> {
  for (const path of binaryCandidates()) {
    if (await isExecutable(path)) return [accountFor({ path })];
  }
  return [];
}

function runAgy(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      path,
      ["-p", "/quota"],
      {
        timeout: FETCH_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        cwd: tmpdir(),
        env: process.env,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Runs the CLI once and turns its output into a report; throws on CLI failure. */
async function readQuota(input: AgyUsageInput): Promise<UsageReport> {
  if (!(await isExecutable(input.path))) {
    return unavailable({ kind: "no_quota", detail: "agy binary not found" });
  }

  let stdout: string;
  try {
    stdout = await runAgy(input.path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not logged in|sign in|authentication/i.test(message)) {
      return unavailable({ kind: "no_quota", detail: "agy is not signed in" });
    }
    throw new Error(`agy /quota failed: ${message}`);
  }

  const windows = quotaWindows(parseQuotaOutput(stdout));
  if (windows.length === 0) {
    return unavailable({
      kind: "no_quota",
      detail: "agy printed no quota windows",
    });
  }

  return { status: "available", windows };
}

interface CacheEntry {
  at: number;
  report: UsageReport;
}

type RefreshOutcome =
  | { kind: "ok"; entry: CacheEntry }
  | { kind: "unavailable"; report: UsageReport }
  | { kind: "failed"; error: unknown };

/** One snapshot per agy binary, keyed by path. */
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<RefreshOutcome>>();
/** Nothing spawns unless someone actually looked at the panel recently. */
let lastDemandAt = 0;
const IDLE_STOP_MS = 30 * 60 * 1000;

function minutesSince(at: number, now: number): number {
  return Math.max(0, Math.round((now - at) / 60_000));
}

/** The report the panel shows, with the cache age spelled out so 15-minute-old numbers are not
 * passed off as live. */
function withCacheNote(entry: CacheEntry, now: number): UsageReport {
  if (entry.report.status !== "available") return entry.report;
  return {
    ...entry.report,
    details: [
      {
        id: "refresh",
        label: "额度刷新",
        value: `agy 后台刷新，${minutesSince(entry.at, now)} 分钟前`,
      },
      ...(entry.report.details ?? []),
    ],
  };
}

/** Single-flight refresh; a failed run keeps the previous numbers rather than blanking the card. */
async function refresh(input: AgyUsageInput): Promise<RefreshOutcome> {
  const running = inFlight.get(input.path);
  if (running) return running;
  const run = (async (): Promise<RefreshOutcome> => {
    const previous = cache.get(input.path) ?? null;
    try {
      const report = await readQuota(input);
      if (report.status === "available") {
        const entry = { at: Date.now(), report };
        cache.set(input.path, entry);
        return { kind: "ok", entry };
      }
      return previous ? { kind: "ok", entry: previous } : { kind: "unavailable", report };
    } catch (error) {
      return previous ? { kind: "ok", entry: previous } : { kind: "failed", error };
    } finally {
      inFlight.delete(input.path);
    }
  })();
  inFlight.set(input.path, run);
  return run;
}

/** Warms the cache at plugin start and from the refresh timer; never throws. */
export async function warmUp(): Promise<void> {
  const accounts = await discover().catch(() => []);
  const first = accounts[0];
  if (!first) return;
  await refresh(first.input as AgyUsageInput);
}

/** Keeps a recently-opened panel warm; the timer calls this and it stays free while nobody looks. */
export async function maintainRefresh(): Promise<void> {
  if (Date.now() - lastDemandAt > IDLE_STOP_MS) return;
  await warmUp();
}

export async function fetchUsage(input: AgyUsageInput): Promise<UsageReport> {
  lastDemandAt = Date.now();
  const now = lastDemandAt;
  const entry = cache.get(input.path);
  if (entry) {
    const age = now - entry.at;
    if (age < MAX_REPORT_AGE_MS) {
      if (age > BACKGROUND_REFRESH_AFTER_MS && !inFlight.has(input.path)) {
        void refresh(input);
      }
      return withCacheNote(entry, now);
    }
  }

  const outcome = await refresh(input);
  if (outcome.kind === "ok") return withCacheNote(outcome.entry, Date.now());
  if (outcome.kind === "unavailable") return outcome.report;
  throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
}
