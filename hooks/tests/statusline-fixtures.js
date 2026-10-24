#!/usr/bin/env node
// Fixture suite for the two status lines. Runs the LIVE hooks as child processes with mock
// payloads on stdin (the same way Claude Code invokes them) and both renders them for eyeball
// review and asserts the invariants that matter:
//
//   - never throws, never exits non-zero, never prints "undefined"/"NaN"
//   - every rendered line fits inside COLUMNS once ANSI escapes are discounted
//   - segments drop by priority as the terminal narrows; identity + model never drop
//   - CLAUDE_STATUSLINE_ASCII=1 output is pure ASCII, NO_COLOR=1 output has no escapes
//   - subagent rows are one valid JSON object per line with ids matching the input tasks
//
// Usage: node hooks/tests/statusline-fixtures.js [--plain]
//        --plain strips color from the preview (assertions are unaffected)

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOKS = path.resolve(__dirname, '..');
const MAIN = path.join(HOOKS, 'statusline.js');
const SUB = path.join(HOOKS, 'subagent-statusline.js');
const L = require(path.join(HOOKS, 'statusline-lib.js'));
const PLAIN = process.argv.includes('--plain');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return true; }
  failures.push(detail ? `${name}: ${detail}` : name);
  return false;
}

// Both hooks reserve part of the terminal width for the TUI's own inset, which is what stops
// Ink truncating the tail with an ellipsis. Pinned here so the width assertions are exact.
const RESERVE = 6;
const ROW_RESERVE = 6;

// A fake home carrying a settings.json with NO model key - the state pinMarker() treats as
// "nothing to diverge from". Every case runs against this unless it deliberately overrides HOME
// or CLAUDE_MODEL_PIN, so the suite's result never depends on what the live machine has pinned.
const NEUTRAL_HOME = path.join(__dirname, '.fakehome-sl-neutral');
fs.mkdirSync(path.join(NEUTRAL_HOME, '.claude'), { recursive: true });
fs.writeFileSync(
  path.join(NEUTRAL_HOME, '.claude', 'settings.json'),
  JSON.stringify({ statusLine: { type: 'command' } }, null, 2),
);

function run(script, payload, env) {
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      COLUMNS: '100',
      CLAUDE_STATUSLINE_RESERVE: String(RESERVE),
      CLAUDE_STATUSLINE_ROW_RESERVE: String(ROW_RESERVE),
      // Neutral pin by DEFAULT. pinMarker() falls back to reading the real
      // ~/.claude/settings.json when CLAUDE_MODEL_PIN is unset, so any case that did not set it
      // inherited the live machine's model key: with a pin saved, the "!pin=... -> /model ..."
      // marker appeared in rows that do not expect it and crowded the branch off the row. A fixture must not
      // read live config. Cases that are ABOUT the pin still override this via their own env.
      HOME: NEUTRAL_HOME,
      USERPROFILE: NEUTRAL_HOME,
      CLAUDE_MODEL_PIN: '',
      ...env,
    },
    timeout: 10000,
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function preview(title, out, cols) {
  const ruler = '-'.repeat(Math.min(cols, 120));
  process.stdout.write(`\n== ${title}  (COLUMNS=${cols})\n${ruler}\n`);
  for (const line of out.split('\n')) process.stdout.write((PLAIN ? L.strip(line) : line) + '\n');
  process.stdout.write(ruler + '\n');
}

// ---------------------------------------------------------------- payload builders
const base = {
  session_id: 'abc123',
  cwd: 'C:/Users/you/projects/app',
  workspace: { current_dir: 'C:/Users/you/projects/app', project_dir: 'C:/Users/you/projects/app', added_dirs: [] },
  model: { id: 'claude-opus-5[1m]', display_name: 'Opus 5' },
  version: '2.1.0',
  output_style: { name: 'default' },
  thinking: { enabled: true },
};

const full = {
  ...base,
  session_name: 'statusline-work',
  effort: { level: 'xhigh' },
  fast_mode: true,
  cost: { total_cost_usd: 1.5, total_duration_ms: 45 * 60000, total_api_duration_ms: 10 * 60000, total_lines_added: 120, total_lines_removed: 30 },
  context_window: { total_input_tokens: 290000, total_output_tokens: 10000, context_window_size: 1000000, used_percentage: 30, remaining_percentage: 70 },
  exceeds_200k_tokens: false,
  rate_limits: {
    five_hour: { used_percentage: 20, resets_at: Math.floor(Date.now() / 1000) + 2 * 3600 },
    seven_day: { used_percentage: 40, resets_at: Math.floor(Date.now() / 1000) + 3 * 86400 },
  },
  pr: { number: 1234, url: 'https://github.com/anthropics/claude-code/pull/1234', review_state: 'approved' },
};

const fresh = { ...base, context_window: { context_window_size: 1000000, used_percentage: null, current_usage: null } };

const hot = {
  ...full,
  session_name: undefined,
  fast_mode: false,
  context_window: { ...full.context_window, total_input_tokens: 930000, used_percentage: 94 },
  rate_limits: {
    five_hour: { used_percentage: 95, resets_at: Math.floor(Date.now() / 1000) + 900 },
    seven_day: { used_percentage: 73, resets_at: Math.floor(Date.now() / 1000) + 90000 },
  },
};

const agentish = {
  ...base,
  agent: { name: 'security-reviewer' },
  effort: { level: 'high' },
  thinking: { enabled: false },
  vim: { mode: 'NORMAL' },
  output_style: { name: 'explanatory' },
  worktree: { name: 'fix-parser', path: 'C:/x/.claude/worktrees/fix-parser', branch: 'worktree-fix-parser', original_branch: 'main' },
  context_window: { total_input_tokens: 120000, total_output_tokens: 4000, context_window_size: 200000, used_percentage: 62 },
  cost: { total_cost_usd: 3.5, total_duration_ms: 5400000, total_api_duration_ms: 900000, total_lines_added: 12, total_lines_removed: 400 },
};

const drifted = { ...full, model: { id: 'claude-fable-5', display_name: 'Fable 5' } };

const noLimits = { ...full, rate_limits: undefined, pr: undefined, session_name: undefined };

const cases = [
  ['full session', full, 100],
  ['fresh session (no ctx / cost / limits)', fresh, 100],
  ['hot: 94% ctx, 95% five-hour', hot, 100],
  ['agent session, worktree, vim, thinking off', agentish, 100],
  ['model drifted from the settings pin', drifted, 100],
  ['no rate limits (API billing)', noLimits, 100],
  ['wide terminal', full, 160],
  ['narrow terminal', full, 60],
  ['very narrow terminal', full, 42],
];

for (const [name, payload, cols] of cases) {
  const r = run(MAIN, payload, { COLUMNS: String(cols) });
  // A background-painted bar disappears once color is stripped, so --plain previews the same
  // geometry drawn with block characters instead. Assertions still run on the real output.
  preview(name, PLAIN ? run(MAIN, payload, { COLUMNS: String(cols), CLAUDE_STATUSLINE_BAR: 'blocks' }).out : r.out, cols);
  check(name + ' / exit 0', r.code === 0, `exit ${r.code} stderr=${r.err.trim()}`);
  check(name + ' / non-empty', r.out.trim().length > 0);
  check(name + ' / no undefined-NaN', !/undefined|NaN/.test(L.strip(r.out)), L.strip(r.out));
  for (const [i, line] of r.out.split('\n').entries()) {
    // The hard bound is the reserved width, not COLUMNS: anything wider gets an Ink ellipsis.
    check(`${name} / line ${i + 1} fits the reserve`, L.vlen(line) <= cols - RESERVE,
      `${L.vlen(line)} > ${cols - RESERVE}: ${L.strip(line)}`);
  }
  // identity and model are priority 100: they survive every width
  const flat = L.strip(r.out);
  check(name + ' / keeps dir', flat.includes('app'), flat);
  check(name + ' / keeps model', /Opus 5|Fable 5/.test(flat), flat);
}

// Line 2 is three gauges: the context bar plus a bar per rate-limit window. They shrink to fit
// rather than letting the row overflow, and the two limit bars always match each other.
for (const cols of [160, 120, 100, 80, 64]) {
  // Geometry is asserted in blocks mode, where the bar cells are visible characters. The
  // default background mode paints the same cells as a colored background (checked below).
  const r = run(MAIN, full, { COLUMNS: String(cols), CLAUDE_STATUSLINE_BAR: 'blocks' });
  const line2 = r.out.split('\n')[1] || '';
  const plain = L.strip(line2);
  // A gauge is the bar cells plus, when it fits, the percentage written inside them.
  const gauge = (label) => {
    const m = new RegExp(label + ' ((?:[\u2588\u2591]|=|-|\\d|%)+)').exec(plain);
    return m ? m[1] : '';
  };
  const bars = [gauge('ctx'), gauge('5h'), gauge('7d')];
  check(`limits ${cols} / three gauges`, bars.every((b) => b.length > 0), `${JSON.stringify(bars)}: ${plain}`);
  if (bars.every((b) => b.length > 0)) {
    check(`limits ${cols} / all three bars match`, bars[0].length === bars[1].length && bars[1].length === bars[2].length,
      `ctx ${bars[0].length}, 5h ${bars[1].length}, 7d ${bars[2].length}`);
    check(`limits ${cols} / bars stay small`, bars[1].length <= 12 && bars[1].length >= 4, `${bars[1].length}`);
    // Wide enough to hold it, so the percentage belongs inside the bar, not beside it.
    if (cols >= 80) {
      check(`limits ${cols} / ctx pct inside the bar`, /%/.test(bars[0]), bars[0]);
      check(`limits ${cols} / limit pct inside the bar`, /%/.test(bars[1]) && /%/.test(bars[2]), `${bars[1]} ${bars[2]}`);
      check(`limits ${cols} / pct is not also outside`, !/[\u2588\u2591=-] \d+%/.test(plain), plain);
    }
  }
  check(`limits ${cols} / both windows survive`, /5h/.test(plain) && /7d/.test(plain), plain);
  check(`limits ${cols} / no ink ellipsis needed`, L.vlen(line2) <= cols - RESERVE, `${L.vlen(line2)} > ${cols - RESERVE}`);

  // Background mode: same geometry, but the bar is a colored background the number sits on.
  const bgRun = run(MAIN, full, { COLUMNS: String(cols) });
  const bgLine = bgRun.out.split('\n')[1] || '';
  check(`bg ${cols} / paints a background`, /\x1b\[48;5;\d+m/.test(bgLine), JSON.stringify(bgLine.slice(0, 60)));
  check(`bg ${cols} / resets the background`, !/\x1b\[48;5;\d+m(?![\s\S]*\x1b\[49m)/.test(bgLine), 'unclosed background run');
  check(`bg ${cols} / same width as blocks mode`, L.vlen(bgLine) === L.vlen(line2), `${L.vlen(bgLine)} vs ${L.vlen(line2)}`);
  check(`bg ${cols} / percentages still shown`, (L.strip(bgLine).match(/%/g) || []).length === 3, L.strip(bgLine));
}

// A long display name plus a full right-hand group is the shape most likely to overflow.
{
  const wide = { ...full, model: { id: 'claude-opus-5[1m]', display_name: 'Opus 5 (1M context)' }, agent: { name: 'claude' } };
  const r = run(MAIN, wide, { COLUMNS: '150' });
  const flat = L.strip(r.out);
  check('long model name / shortened to 1M', /Opus 5 1M/.test(flat) && !/1M context/.test(flat), flat.split('\n')[0]);
  check('default agent name / no badge', !/@claude/.test(flat), flat.split('\n')[0]);
  for (const line of r.out.split('\n')) {
    check('long model name / fits', L.vlen(line) <= 150 - RESERVE, `${L.vlen(line)}: ${L.strip(line)}`);
  }
}

// The row answers two questions before anything else: WHICH FOLDER, and WHICH BRANCH. The AI-generated session title used to hold the first spot and answered neither,
// so it must not render at all - a title that comes back would push the folder rightwards again.
{
  const title = 'example session title text';
  for (const cols of [150, 100, 80, 60]) {
    const r = run(MAIN, { ...full, session_name: title }, { COLUMNS: String(cols) });
    const first = L.strip(r.out).split('\n')[0];
    check(`title ${cols} / never rendered`, !/example|session title/.test(first), first);
    check(`title ${cols} / folder leads the row`, /^(projects\/)?app(\s|$)/.test(first), first);
  }
  // The parent rides in front of the leaf where there is room for it, and gives up those cells
  // on a cramped row rather than pushing the model out.
  const wideRow = L.strip(run(MAIN, base, { COLUMNS: '120' }).out).split('\n')[0];
  check('folder / parent shown on a wide row', wideRow.startsWith('projects/app'), wideRow);
  const narrowRow = L.strip(run(MAIN, base, { COLUMNS: '60' }).out).split('\n')[0];
  check('folder / parent dropped on a narrow row', narrowRow.startsWith('app'), narrowRow);
  // A drive letter is not a folder name worth the cells.
  const rootish = { ...base, cwd: 'C:/scratch', workspace: { current_dir: 'C:/scratch' } };
  const rootRow = L.strip(run(MAIN, rootish, { COLUMNS: '120' }).out).split('\n')[0];
  check('folder / drive letter is not a parent', rootRow.startsWith('scratch '), rootRow);
}

// Branch: read straight off .git/HEAD, so a directory carrying one is enough to drive the
// assertion (the dirty counts shell out and fail soft to "clean"). Priority 95 - it survives
// every width the model survives, and sits immediately after the folder.
{
  const mk = (name, head) => {
    // Short enough to survive the leaf cap at 60 columns - the long-name case is asserted below.
    const d = path.join(os.tmpdir(), 'claude-fx-' + name);
    fs.mkdirSync(path.join(d, '.git'), { recursive: true });
    fs.writeFileSync(path.join(d, '.git', 'HEAD'), head + '\n');
    return d;
  };
  const onBranch = mk('repo', 'ref: refs/heads/feature/status-row');
  const detached = mk('det', '9f3a1c2b7d4e5f60718293a4b5c6d7e8f9012345');
  try {
    // A crowded row (cost + PR + flags) at 80 and up, then a lean one at 60: everything with a
    // priority below the branch is given up first, so the branch is still standing.
    for (const [cols, payload] of [[150, full], [100, full], [80, full], [60, base]]) {
      const r = run(MAIN, { ...payload, cwd: onBranch, workspace: { current_dir: onBranch } }, { COLUMNS: String(cols) });
      const first = L.strip(r.out).split('\n')[0];
      check(`branch ${cols} / shown`, /feature\/status-row/.test(first), first);
      check(`branch ${cols} / sits right after the folder`,
        /claude-fx-repo\s+\u00b7\s+feature\/status-row/.test(first), first);
      check(`branch ${cols} / row still fits`, r.out.split('\n').every((l) => L.vlen(l) <= cols - RESERVE), L.strip(r.out));
    }
    // A folder name long enough to crowd the row gets capped rather than eating the branch.
    const longDir = mk('a-very-long-project-folder-name-indeed', 'ref: refs/heads/main');
    try {
      const r = L.strip(run(MAIN, { ...base, cwd: longDir, workspace: { current_dir: longDir } }, { COLUMNS: '80' }).out).split('\n')[0];
      check('branch / survives a long folder name', /\bmain\b/.test(r), r);
      check('branch / long folder name is marked as cut', /\.\./.test(r.split(' \u00b7 ')[0]), r);
    } finally { try { fs.rmSync(longDir, { recursive: true, force: true }); } catch (_) {} }
    const det = L.strip(run(MAIN, { ...full, cwd: detached, workspace: { current_dir: detached } }, { COLUMNS: '120' }).out).split('\n')[0];
    check('branch / detached HEAD shows the short sha', /9f3a1c2b/.test(det), det);
    // The dirty-count cache is per-user under ~/.claude, not in the shared temp dir (its file
    // names encode project paths). The old hook wrote os.tmpdir()/claude-statusline-git.
    const gitCache = path.join(NEUTRAL_HOME, '.claude', '.statusline-git');
    try { fs.rmSync(gitCache, { recursive: true, force: true }); } catch (_) {}
    run(MAIN, { ...base, cwd: onBranch, workspace: { current_dir: onBranch } }, { COLUMNS: '100' });
    let cached = [];
    try { cached = fs.readdirSync(gitCache).filter((f) => f.endsWith('.json')); } catch (_) {}
    check('git cache / written under ~/.claude/.statusline-git', cached.length >= 1, 'no cache file in ' + gitCache);
  } finally {
    for (const d of [onBranch, detached]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  }
  // Not a checkout at all: no branch segment invented, and no empty separator left behind.
  const plainDir = L.strip(run(MAIN, { ...base, cwd: os.tmpdir(), workspace: { current_dir: os.tmpdir() } }, { COLUMNS: '120' }).out).split('\n')[0];
  check('branch / none outside a repo', !/ \u00b7 \u00b7 /.test(plainDir) && !/clean/.test(plainDir), plainDir);
}

// the pin marker has to carry the fix, not just flag the drift
{
  const r = run(MAIN, drifted, { CLAUDE_MODEL_PIN: 'claude-opus-5', COLUMNS: '100' });
  check('pin drift / marker present', /!pin=opus-5 -> \/model opus/.test(L.strip(r.out)), L.strip(r.out));
  const r2 = run(MAIN, full, { CLAUDE_MODEL_PIN: 'claude-opus-5', COLUMNS: '100' });
  check('pin match / no marker', !/!pin=/.test(L.strip(r2.out)), L.strip(r2.out));
}

// The settings.json arm of pinMarker. The two cases above BOTH set
// CLAUDE_MODEL_PIN, so the branch that production actually takes - no env var, pin read out of
// ~/.claude/settings.json - needs its own coverage. Both states are pinned here against a sandboxed HOME:
//
//   (a) settings.json HAS a "model" key -> a divergent live model raises the !pin= marker.
//   (b) settings.json has NO "model" key -> deliberate. No key is a valid
//       state (config-drift-check.js runs MODEL_PIN='default'), so the old behavior - stay
//       silent because there is nothing to diverge FROM - left no on-screen detector
//       at all. With no pin, the marker
//       now names Fable directly and stays silent on every other tier.
//       The OLD predicate would have been SILENT on the case below: it returned '' whenever the
//       pin key was absent, regardless of the live model. That is asserted explicitly, so this
//       fixture pins a real change rather than going green on day one.
//
// CLAUDE_MODEL_PIN is passed EMPTY rather than omitted: the hook tests it with `if (!pin)`, so
// '' falls through to the settings.json read, and an empty string cannot be inherited-by-accident
// from the parent environment the way an unset variable can.
{
  const SANDBOX = path.join(__dirname, '.fakehome-sl');
  const sfile = path.join(SANDBOX, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(sfile), { recursive: true });
  const withHome = (settings) => {
    fs.writeFileSync(sfile, JSON.stringify(settings, null, 2));
    return run(MAIN, drifted, {
      CLAUDE_MODEL_PIN: '', HOME: SANDBOX, USERPROFILE: SANDBOX, COLUMNS: '100',
    });
  };
  const pinned = L.strip(withHome({ model: 'claude-opus-5', env: {} }).out);
  check('pin via settings.json / marker present', /!pin=opus-5 -> \/model opus/.test(pinned), pinned);
  const unpinned = L.strip(withHome({ env: {} }).out);
  check('pin via settings.json / no key raises no !pin= marker', !/!pin=/.test(unpinned), unpinned);
  // No pin + live Fable must still be called out.
  check('pin via settings.json / no key but Fable live raises !fable', /!fable/.test(unpinned), unpinned);
  // The OLD predicate (`if (!p || !l || p === l) return ''`) returned '' here, so this case would
  // have been SILENT before the change - the fixture pins the change, not the status quo.
  const OLD = (p, l) => (!p || !l || p === l ? '' : 'marker');
  check('pin via settings.json / OLD predicate WOULD have been silent on this input',
    OLD('', 'fable-5') === '', 'old predicate returned ""');
  // and the divergent model is still NAMED on the row.
  check('pin via settings.json / live model still shown', /Fable/i.test(unpinned), unpinned);
  // No pin and a non-escalation live model stays quiet - the marker must not become ambient noise.
  const quiet = L.strip(run(MAIN, full, {
    CLAUDE_MODEL_PIN: '', HOME: SANDBOX, USERPROFILE: SANDBOX, COLUMNS: '100',
  }).out);
  check('pin via settings.json / no key and non-Fable live stays silent',
    !/!fable/.test(quiet) && !/!pin=/.test(quiet), quiet);
  // A malformed settings.json must fail soft to "no marker", never take the status line down.
  fs.writeFileSync(sfile, '{ not json at all');
  const broken = run(MAIN, drifted, {
    CLAUDE_MODEL_PIN: '', HOME: SANDBOX, USERPROFILE: SANDBOX, COLUMNS: '100',
  });
  check('pin via settings.json / broken file fails soft', broken.code === 0 && !/!pin=/.test(L.strip(broken.out)),
    `exit ${broken.code}: ${L.strip(broken.out)}`);
}

// glyph + color escape hatches
{
  const r = run(MAIN, full, { CLAUDE_STATUSLINE_ASCII: '1', COLUMNS: '100' });
  preview('ASCII fallback (CLAUDE_STATUSLINE_ASCII=1)', r.out, 100);
  check('ascii mode / pure ASCII body', !/[^\x00-\x7F]/.test(L.strip(r.out)), L.strip(r.out));
  const r2 = run(MAIN, full, { NO_COLOR: '1', COLUMNS: '100' });
  preview('NO_COLOR=1', r2.out, 100);
  check('no-color mode / no escapes', !/\x1b/.test(r2.out), JSON.stringify(r2.out));
}

// ---------------------------------------------------------------- agent panel rows
const now = Date.now();
const tasks = {
  columns: 96,
  session_id: 'abc123',
  cwd: 'C:/Users/you/projects/app',
  tasks: [
    {
      id: 't1', name: 'explore-hooks', type: 'local_agent', status: 'running',
      description: 'scan ~/.claude/hooks for statusline wiring', label: 'scanning hooks dir',
      startTime: now - 120000, model: 'claude-sonnet-5', effort: 'xhigh',
      contextWindowSize: 200000, tokenCount: 30000, tokenSamples: [20000, 22500, 25000, 27500, 30000],
    },
    {
      id: 't2', name: 'verify-payload', type: 'local_agent', status: 'completed',
      description: 'confirm the subagentStatusLine contract against the binary', label: 'done: contract confirmed',
      startTime: now - 420000, model: 'claude-opus-5[1m]', effort: 500,
      contextWindowSize: 1000000, tokenCount: 90000, tokenSamples: [90000, 90000],
    },
    {
      id: 't3', name: 'flaky-one', type: 'local_agent', status: 'failed',
      description: 'died on a 529', label: '', startTime: now - 60000,
      model: 'claude-haiku-4-5-20251001', contextWindowSize: 200000, tokenCount: 1200, tokenSamples: [1200],
    },
    {
      id: 't4', name: 'no-model-yet', type: 'local_agent', status: 'pending',
      description: 'queued behind the concurrency cap', label: 'queued', startTime: now - 5000,
      tokenCount: 0, tokenSamples: [],
    },
  ],
};

function checkRows(name, payload, env) {
  const r = run(SUB, payload, env);
  check(name + ' / exit 0', r.code === 0, `exit ${r.code} stderr=${r.err.trim()}`);
  const lines = r.out.split('\n').filter(Boolean);
  check(name + ' / one line per task', lines.length === payload.tasks.length, `${lines.length} lines for ${payload.tasks.length} tasks`);
  process.stdout.write(`\n== ${name}  (columns=${payload.columns})\n${'-'.repeat(payload.columns)}\n`);
  for (const line of lines) {
    let obj = null;
    check(name + ' / valid JSON line', (() => { try { obj = JSON.parse(line); return true; } catch (_) { return false; } })(), line);
    if (!obj) continue;
    check(name + ' / known id', payload.tasks.some((t) => t.id === obj.id), obj.id);
    check(name + ' / row fits the gutter reserve', L.vlen(obj.content) <= payload.columns - ROW_RESERVE,
      `${L.vlen(obj.content)} > ${payload.columns - ROW_RESERVE}: ${L.strip(obj.content)}`);
    check(name + ' / no undefined-NaN', !/undefined|NaN/.test(L.strip(obj.content)), L.strip(obj.content));
    process.stdout.write((PLAIN ? L.strip(obj.content) : obj.content) + '\n');
  }
  process.stdout.write('-'.repeat(payload.columns) + '\n');
  return r;
}

checkRows('agent rows, 96 cols', tasks, { CLAUDE_STATUSLINE_BAR: 'blocks' });
checkRows('agent rows, 50 cols', { ...tasks, columns: 50 }, { CLAUDE_STATUSLINE_BAR: 'blocks' });
checkRows('agent rows, ascii', tasks, { CLAUDE_STATUSLINE_ASCII: '1', CLAUDE_STATUSLINE_BAR: 'blocks' });

// The per-row context gauge matches the main line: painted background by default, and dropped
// entirely on a panel too narrow to hold it.
{
  const wide = run(SUB, tasks);
  const wideRows = wide.out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('rows / gauge paints a background', wideRows.some((r) => /\x1b\[48;5;\d+m/.test(r.content)),
    JSON.stringify(wideRows[0].content.slice(0, 80)));
  check('rows / gauge closes its background', !/\x1b\[48;5;\d+m(?![\s\S]*\x1b\[49m)/.test(wideRows[0].content), 'unclosed background run');
  const narrow = run(SUB, { ...tasks, columns: 60 });
  const narrowRows = narrow.out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('rows / narrow panel drops the gauge', !narrowRows.some((r) => /\x1b\[48;5;\d+m/.test(r.content)),
    L.strip(narrowRows[0].content));
  check('rows / narrow panel keeps the pct', /\d+%/.test(L.strip(narrowRows[0].content)), L.strip(narrowRows[0].content));
}

// The grid invariants: columns are dropped for every row at once, and every row ends at the
// same cell, which is what makes the stat columns line up.
for (const cols of [96, 70, 50, 40]) {
  const r = run(SUB, { ...tasks, columns: cols });
  const rendered = r.out.split('\n').filter(Boolean).map((l) => L.strip(JSON.parse(l).content));
  const withModel = rendered.filter((s) => /sonnet|opus|haiku/.test(s)).length;
  check(`grid ${cols} / model column is all-or-nothing`, withModel === 0 || withModel === 3, `${withModel} of 3 rows show a model`);
  const rates = rendered.filter((s) => /\/m\b/.test(s)).length;
  check(`grid ${cols} / rate column is all-or-nothing`, rates === 0 || rates === 1, `${rates} rows show a rate`);
  const widths = new Set(rendered.map((s) => s.length));
  check(`grid ${cols} / rows share a right edge`, widths.size === 1, `row widths: ${[...widths].join(',')}`);
}

// content assertions on the wide render
{
  const r = run(SUB, tasks);
  const rows = r.out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const byId = Object.fromEntries(rows.map((x) => [x.id, L.strip(x.content)]));
  check('rows / model shown', /sonnet/.test(byId.t1), byId.t1);
  check('rows / effort shown', /xhigh/.test(byId.t1), byId.t1);
  check('rows / 1m window model', /opus 1m/.test(byId.t2), byId.t2);
  check('rows / numeric effort humanized', /500/.test(byId.t2), byId.t2);
  check('rows / token count', /30k/.test(byId.t1), byId.t1);
  check('rows / token pct', /15%/.test(byId.t1), byId.t1);
  check('rows / elapsed', /2m/.test(byId.t1), byId.t1);
  check('rows / token rate on a live row', /\/m/.test(byId.t1), byId.t1);
  check('rows / no rate on a finished row', !/\/m/.test(byId.t2), byId.t2);
  check('rows / name kept when unlabeled', /flaky-one/.test(byId.t3), byId.t3);
  // SGR 2/22 do not nest: a finished row must re-arm dim after every inner "dim off",
  // otherwise the tail of the row snaps back to full brightness.
  const doneRow = rows.find((x) => x.id === 't2').content;
  check('rows / finished row starts dim', doneRow.startsWith('\x1b[2m'), JSON.stringify(doneRow.slice(0, 12)));
  const body = doneRow.slice(4, -4);
  check('rows / finished row re-arms dim', !/\x1b\[22m(?!\x1b\[2m)/.test(body), JSON.stringify(body));
  check('rows / model-less row still renders', /no-model-yet/.test(byId.t4), byId.t4);
}

// empty task list must stay silent so Claude Code keeps its own rendering
{
  const r = run(SUB, { columns: 96, tasks: [] });
  check('empty tasks / silent', r.out.trim() === '' && r.code === 0, JSON.stringify(r.out));
  const r2 = run(SUB, {});
  check('no tasks key / silent', r2.out.trim() === '' && r2.code === 0, JSON.stringify(r2.out));
}

// garbage in must not crash either hook
{
  const env = { ...process.env, COLUMNS: '100', HOME: NEUTRAL_HOME, USERPROFILE: NEUTRAL_HOME };
  const r = spawnSync(process.execPath, [MAIN], { input: 'not json at all', encoding: 'utf8', env });
  check('main / survives garbage stdin', r.status === 0, `exit ${r.status} ${r.stderr}`);
  const r2 = spawnSync(process.execPath, [SUB], { input: 'not json at all', encoding: 'utf8', env });
  check('subagent / survives garbage stdin', r2.status === 0, `exit ${r2.status} ${r2.stderr}`);
}

process.stdout.write(`\n${pass} checks passed, ${failures.length} failed\n`);
for (const f of failures) process.stdout.write('  FAIL ' + f + '\n');
process.exit(failures.length ? 1 : 0);
