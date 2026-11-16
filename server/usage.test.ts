import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fetchUsage, parseQuotaOutput } from "./usage.ts";

/** Captured verbatim from `agy -p "/quota"` on 2026-11-10. */
const REAL_OUTPUT = [
  "Gemini Models\tWeekly Limit Remaining\t13%\t2026-11-13T23:43:48Z",
  "Gemini Models\tFive Hour Limit Remaining\t90%\t2026-11-10T10:33:10Z",
  "Claude and GPT models\tWeekly Limit Remaining\t26%\t2026-11-16T23:55:50Z",
  "Claude and GPT models\tFive Hour Limit Remaining\t56%\t2026-11-10T10:48:07Z",
  "",
].join("\n");

/** A stand-in for `agy -p "/quota"` that records how many times it was started. */
async function fakeAgy(options: { exitCode?: number; stdout?: string } = {}): Promise<{
  path: string;
  runs: () => Promise<number>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "agy-usage-test-"));
  const counter = join(dir, "runs.txt");
  const script = join(dir, "agy");
  const body =
    options.exitCode === undefined ? `cat <<'QUOTA_EOF'\n${options.stdout ?? REAL_OUTPUT}\nQUOTA_EOF` : `exit ${options.exitCode}`;
  await writeFile(
    script,
    `#!/bin/sh\necho run >> ${JSON.stringify(counter)}\n${body}\n`,
    "utf8",
  );
  await chmod(script, 0o755);
  return {
    path: script,
    runs: () => readFile(counter, "utf8").then((text) => text.split("\n").filter(Boolean).length, () => 0),
  };
}

test("parses every printed window with its reset time", () => {
  const lines = parseQuotaOutput(REAL_OUTPUT);
  assert.equal(lines.length, 4);
  assert.deepEqual(lines[0], {
    group: "Gemini Models",
    label: "Weekly Limit Remaining",
    remainingPct: 13,
    resetsAt: "2026-11-13T23:43:48.000Z",
  });
  assert.equal(lines[3]?.remainingPct, 56);
});

test("ignores chatter, prose and out-of-range numbers", () => {
  const stdout = [
    "Fetching quota...",
    "",
    "Gemini Models\tWeekly Limit Remaining\tnot a percent\t2026-11-13T23:43:48Z",
    "Gemini Models\tFive Hour Limit Remaining\t120%\t2026-11-10T10:33:10Z",
    "only two\tcolumns",
    "Claude and GPT models\tWeekly Limit Remaining\t0%\t",
  ].join("\n");
  const lines = parseQuotaOutput(stdout);
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.remainingPct, 100, "120% remaining clamps to 100");
  assert.equal(lines[1]?.remainingPct, 0);
  assert.equal(lines[1]?.resetsAt, null, "a missing reset time stays null");
});

test("a cold fetch reads the CLI and reports used percentages the panel can render", async () => {
  const agy = await fakeAgy();
  const report = await fetchUsage({ path: agy.path });
  assert.equal(report.status, "available");
  if (report.status !== "available") return;
  assert.deepEqual(
    report.windows.map((entry) => [entry.id, entry.usedPct, entry.resetsAt]),
    [
      ["claude-gpt:five-hour", 44, "2026-11-10T10:48:07.000Z"],
      ["gemini:five-hour", 10, "2026-11-10T10:33:10.000Z"],
      ["claude-gpt:weekly", 74, "2026-11-16T23:55:50.000Z"],
      ["gemini:weekly", 87, "2026-11-13T23:43:48.000Z"],
    ],
  );
  assert.match(report.details?.[0]?.value ?? "", /agy 后台刷新/);
  assert.equal(await agy.runs(), 1);
});

test("a repeat fetch answers from the snapshot without booting the CLI again", async () => {
  const agy = await fakeAgy();
  await fetchUsage({ path: agy.path });
  const startedAt = Date.now();
  const second = await fetchUsage({ path: agy.path });
  assert.ok(Date.now() - startedAt < 500, "cached fetch must not wait on a CLI boot");
  assert.equal(second.status, "available");
  assert.equal(await agy.runs(), 1, "the CLI ran exactly once for two fetches");
});

test("output with no quota rows is reported as unavailable, not as an empty card", async () => {
  const agy = await fakeAgy({ stdout: "Fetching quota..." });
  const report = await fetchUsage({ path: agy.path });
  assert.equal(report.status, "unavailable");
  if (report.status !== "unavailable") return;
  assert.equal(report.problem.kind, "no_quota");
});

test("a failing CLI surfaces an error instead of inventing numbers", async () => {
  const agy = await fakeAgy({ exitCode: 3 });
  await assert.rejects(() => fetchUsage({ path: agy.path }), /agy \/quota failed/);
});
