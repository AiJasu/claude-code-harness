#!/usr/bin/env node
// settings.statusLine command: renders the two-line status bar for the Claude Code TUI.
//
//   line 1   parent/dir  branch [~3 ?1]  wt:name  @agent  PR#12          $1.50  45m  +120/-30
//   line 2   ctx <bar> 30% 300k/1M                                5h 20%/2h00m  7d 40%/3d0h
//
// Both lines are width-aware (COLUMNS is exported by Claude Code): the right-hand group is
// pinned to the right edge and low-priority segments drop out before anything truncates.
// Glyph/color policy and the escape-aware helpers live in statusline-lib.js.
// Fast + fail-soft: any error prints a minimal line, never throws.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const L = require(path.join(__dirname, 'statusline-lib.js'));
const { c, dim, bold, C, fmtNum, fmtDur, fmtUntil, pctColor, bar, fit, vlen, trunc, osc8, joinSegs } = L;

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; }
}
function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8', timeout: 1500, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) { return ''; }
}

// Spawn-lean git status:
// branch comes from a plain read of .git/HEAD (no git.exe), dirty flags from
// `git status --porcelain` cached 5 min per repo - one spawn per 5 min instead of
// two per refresh. Staleness of the +/~/? counts is acceptable; branch stays live.
function findGitDir(dir) {
  let d = path.resolve(dir);
  for (let i = 0; i < 30; i++) {
    const g = path.join(d, '.git');
    try {
      const st = fs.statSync(g);
      if (st.isDirectory()) return g;
      const m = fs.readFileSync(g, 'utf8').match(/^gitdir:\s*(.+)\s*$/m); // worktree/submodule
      return m ? path.resolve(d, m[1].trim()) : null;
    } catch (_) {}
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}
function readBranch(gitDir) {
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return m ? m[1] : head.slice(0, 8); // detached HEAD -> short sha
  } catch (_) { return ''; }
}
// The cache lives under ~/.claude, not the shared temp dir: its file names encode project paths.
function dirtyCounts(dir) {
  const cacheDir = path.join(os.homedir(), '.claude', '.statusline-git');
  const key = Buffer.from(String(dir).toLowerCase()).toString('base64url').slice(0, 48);
  const f = path.join(cacheDir, key + '.json');
  try {
    const cached = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Date.now() - cached.ts < 300000 && cached.counts) return cached.counts;
  } catch (_) {}
  const porcelain = git(dir, ['status', '--porcelain']);
  const counts = { staged: 0, dirty: 0, untracked: 0 };
  for (const line of porcelain ? porcelain.split('\n') : []) {
    if (!line) continue;
    if (line.startsWith('??')) { counts.untracked++; continue; }
    if (line[0] && line[0] !== ' ') counts.staged++;
    if (line[1] && line[1] !== ' ') counts.dirty++;
  }
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ ts: Date.now(), counts }));
  } catch (_) {}
  return counts;
}

// A RESUMED thread keeps its transcript's model and ignores a changed default, so a session can
// sit on Fable for weeks with nothing on screen saying so. When the live model differs from the
// pin (settings.json model, or CLAUDE_MODEL_PIN), the marker carries the fix, not just a flag -
// a passive marker does not move a thread. Fails soft to no marker.
function pinMarker(live) {
  try {
    const key = (s) => {
      const m = /(fable|opus|sonnet|haiku)[^a-z0-9]*(\d+(?:[.-]\d+)?)?/i.exec(String(s || ''));
      return m ? (m[1] + (m[2] ? '-' + m[2] : '')).toLowerCase() : '';
    };
    let pin = process.env.CLAUDE_MODEL_PIN;
    if (!pin) {
      const raw = fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8');
      const sj = JSON.parse(raw.replace(/^[^{]+/, '')); // tolerate a BOM / leading noise
      pin = sj && sj.model;
    }
    const p = key(pin), l = key(live);
    if (!l) return '';
    // No pin saved is a valid state (settings.json may have no `model` key, so the CLI default
    // applies and tracks upgrades). That leaves nothing to diverge FROM, which would silently
    // disarm the only on-screen detector for a resumed session sitting on the escalation tier.
    // With no pin, name Fable directly.
    if (!p) return /^fable/.test(l) ? ' ' + c('!fable', C.bad) : '';
    if (p === l) return '';
    return ' ' + c(`!pin=${p} -> /model ${p.split('-')[0]}`, C.bad);
  } catch (_) { return ''; }
}

let data = {};
try { data = JSON.parse(readStdin() || '{}'); } catch (_) {}

// COLUMNS is the full terminal width; the status row renders inside an inset container, so a
// line padded to COLUMNS gets its tail eaten by Ink's own truncate (a trailing ellipsis is the
// symptom). Tune with CLAUDE_STATUSLINE_RESERVE if the right edge sits too far in or too close.
const width = L.columns(L.envInt('CLAUDE_STATUSLINE_RESERVE', 6));
const seg = (text, prio) => (text ? { text, prio } : null);

// ---------------------------------------------------------------- line 1: identity
const dir =
  (data.workspace && (data.workspace.current_dir || data.workspace.project_dir)) ||
  data.cwd || process.cwd();
const dirParts = String(dir).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
const dirName = dirParts[dirParts.length - 1] || String(dir);
// The leaf alone is often ambiguous ("claude", "src", "worktrees/foo"), so the parent rides in
// front of it as a dim prefix. A bare drive letter says nothing, and a cramped row needs the
// cells more than it needs the context - below that width the leaf stands on its own.
const parentRaw = dirParts.length > 1 ? dirParts[dirParts.length - 2] : '';
const parentName = /^[A-Za-z]:$/.test(parentRaw) || width < 80 ? '' : parentRaw;

const left1 = [];

const cap = (max, frac) => Math.max(12, Math.min(max, Math.floor(width / frac)));

// Identity, in reading order: the FOLDER always, then the BRANCH
// whenever this is a checkout. Nothing is allowed in front of them - the AI-generated session
// title used to hold that spot and answered neither question. Both are priority 100/95, so
// they outlive every other segment as the terminal narrows.
// The leaf is capped like every other identity string: an unusually long folder name is not
// allowed to crowd the branch off the row (it did, in the fixture suite, at 60 columns).
left1.push(seg(
  (parentName ? dim(trunc(parentName, 16) + '/') : '') + bold(c(trunc(dirName, cap(30, 3)), C.dir)), 100));

const gitDir = findGitDir(dir);
if (gitDir) {
  const branch = readBranch(gitDir);
  if (branch) {
    const n = dirtyCounts(dir);
    const flags = [];
    if (n.staged) flags.push(c('+' + n.staged, C.ok));
    if (n.dirty) flags.push(c('~' + n.dirty, C.dirty));
    if (n.untracked) flags.push(c('?' + n.untracked, C.mute));
    const state = flags.length ? ' ' + dim('[') + flags.join(' ') + dim(']') : ' ' + dim('clean');
    left1.push(seg(c(trunc(branch, cap(44, 3)), C.branch) + state, 95));
  }
}

// Worktree: --worktree sessions expose worktree.*, plain `git worktree add` checkouts expose
// workspace.git_worktree. Only worth a segment when it is not already the directory name.
const wtName = (data.worktree && data.worktree.name) || (data.workspace && data.workspace.git_worktree);
if (wtName && String(wtName) !== dirName) left1.push(seg(c('wt:' + trunc(String(wtName), cap(28, 4)), C.branch), 65));

// The agent badge stays because it says what this window IS, not what it is called: "claude" is
// the catch-all default (what a plain background job runs as) and says nothing, and neither does
// a name that just repeats the directory.
const rawAgent = data.agent && data.agent.name ? String(data.agent.name) : '';
const agentName = rawAgent && rawAgent !== 'claude' && rawAgent !== dirName ? rawAgent : '';
if (agentName) left1.push(seg(c('@' + trunc(agentName, cap(32, 4)), C.name), 55));

// PR / GitLab MR for the current branch, ctrl-clickable where the terminal supports OSC 8.
const pr = data.pr;
if (pr && pr.number) {
  const st = pr.review_state;
  const code = st === 'approved' ? C.ok : st === 'changes_requested' ? C.bad : st === 'draft' ? C.mute : C.warn;
  const tag = (pr.kind === 'mr' ? 'MR!' : 'PR#') + pr.number;
  const label = osc8(pr.url, c(tag, code)) + (st ? ' ' + dim(st.replace('_', ' ')) : '');
  left1.push(seg(label, 50));
}

// "Opus 5 (1M context)" is a lot of row for one parenthetical; "Opus 5 1M" says the same thing.
const modelName = String((data.model && data.model.display_name) || data.model || 'Claude')
  .replace(/\s*\(1M context\)/i, ' 1M');
const effort = data.effort && data.effort.level;
const modelText =
  c(String(modelName), C.model) +
  (effort ? ' ' + dim(String(effort)) : '') +
  pinMarker((data.model && (data.model.id || data.model.display_name)) || modelName);
left1.push(seg(modelText, 100));

// Session mode flags - only rendered when they deviate from the norm.
const flagBits = [];
if (data.fast_mode) flagBits.push(c('fast', C.flag));
if (data.thinking && data.thinking.enabled === false) flagBits.push(c('think off', C.bad));
if (data.vim && data.vim.mode) flagBits.push(c(String(data.vim.mode), C.label));
const style = data.output_style && data.output_style.name;
if (style && style !== 'default') flagBits.push(c(String(style), C.label));
if (flagBits.length) left1.push(seg(flagBits.join(' '), 40));

// ---------------------------------------------------------------- line 1: cost / effort spent
const cost = data.cost || {};
const right1 = [];
if (typeof cost.total_cost_usd === 'number' && isFinite(cost.total_cost_usd)) {
  const v = cost.total_cost_usd;
  right1.push(seg(c('$' + (v >= 100 ? Math.round(v) : v.toFixed(2)), C.cost), 60));
}
if (cost.total_duration_ms) right1.push(seg(dim(fmtDur(cost.total_duration_ms)), 45));
if (cost.total_api_duration_ms) right1.push(seg(dim('api ' + fmtDur(cost.total_api_duration_ms)), 20));
const added = cost.total_lines_added || 0, removed = cost.total_lines_removed || 0;
if (added || removed) right1.push(seg(c('+' + added, C.ok) + dim('/') + c('-' + removed, C.bad), 35));

// ---------------------------------------------------------------- line 2: context + limits
const cw = data.context_window || {};
const pct = cw.used_percentage != null ? cw.used_percentage : null;
const size = cw.context_window_size;
const used = typeof cw.total_input_tokens === 'number' && typeof cw.total_output_tokens === 'number'
  ? cw.total_input_tokens + cw.total_output_tokens : null;

// The 7d-opus segment is not rendered: older payload builders emitted only five_hour and
// seven_day. Newer schemas declare seven_day_opus, but whether the server populates it is
// unverified. The loop below is generic over N windows, so adding [rl.seven_day_opus, '7dO', 70]
// is the whole change if a live payload ever shows it.
const rl = data.rate_limits || {};
const limits = [];
for (const [obj, label, prio] of [[rl.five_hour, '5h', 90], [rl.seven_day, '7d', 80]]) {
  if (obj && obj.used_percentage != null && isFinite(obj.used_percentage)) {
    limits.push({ label, prio, p: Math.round(obj.used_percentage), until: fmtUntil(obj.resets_at) });
  }
}

const lines = [fit(left1, right1, width)];

// Line 2 is three gauges of the SAME size - context, and one per rate-limit window - so they
// read as one row of instruments. The shared bar width is solved for the terminal rather than
// fixed, so the row always lands inside `width` instead of being truncated: shrink the bars
// first, then give up the token counts and the reset countdowns, and only then let fit() drop
// a whole window.
const BAR_MAX = 8, BAR_MIN = 4;
const shown = pct == null ? null : Math.round(pct);
const ctxCode = pctColor(shown == null ? 0 : shown, 60, 80);

if (shown != null || limits.length) {
  const tokText = used != null && size ? fmtNum(used) + '/' + fmtNum(size) : '';
  const gap = 2; // minimum breathing room between the context gauge and the limits

  // One percentage-field width across every gauge, so all three bars come out identical.
  const ctxPct = shown == null ? '--' : shown + '%';
  const limPct = limits.map((l) => l.p + '%');
  const pctW = Math.max(ctxPct.length, ...limPct.map((s) => s.length), 0);
  const gauges = 1 + limits.length;

  // Fixed (non-bar) cost of a candidate rendering. Each gauge costs its label, a space, the
  // percentage field and one more space - the space either separates the bar from the number
  // or, once the number moves inside, becomes part of the bar. Same total either way.
  const costOf = (withTok, withUntil) => {
    const ctxFixed = 3 + 1 + 1 + pctW + (withTok && tokText ? 1 + tokText.length : 0);
    const limFixed = limits.reduce(
      (sum, l) => sum + l.label.length + 1 + 1 + pctW +
        (withUntil && l.until ? 1 + l.until.length : 0), 0);
    const seps = Math.max(0, limits.length - 1) * 3;
    return ctxFixed + limFixed + seps + (limits.length ? gap : 0);
  };

  // Preference order: keep everything, then drop the token counts, then the countdowns.
  let choice = null;
  for (const [withTok, withUntil] of [[true, true], [false, true], [true, false], [false, false]]) {
    const fixed = costOf(withTok, withUntil);
    let barW = BAR_MAX;
    while (fixed + barW * gauges > width && barW > BAR_MIN) barW--;
    choice = { withTok, withUntil, barW, fits: fixed + barW * gauges <= width };
    if (choice.fits) break;
  }
  // Last resort: no room for bars at all, then let fit() drop the 7d window.
  if (!choice.fits) choice = { withTok: false, withUntil: false, barW: 0, fits: true };

  // The percentage reads better written ON the bar than parked beside it. Moving it inside
  // frees exactly the cells it occupied outside (the number plus its space), so the bar is
  // drawn that much wider and the solved row width is unchanged.
  const drawn = choice.barW ? choice.barW + pctW + 1 : 0;
  const inline = !!drawn && L.canInline('x'.repeat(pctW), drawn);

  const gaugeOf = (label, code, pctText, value, extra) => {
    const parts = [label];
    if (drawn) parts.push(bar(value, drawn, code, inline ? pctText : ''));
    if (!inline) parts.push(c(pctText, code));
    if (extra) parts.push(extra);
    return parts.join(' ');
  };

  const ctxSeg = gaugeOf(c('ctx', C.label), ctxCode, ctxPct, shown == null ? 0 : shown,
    choice.withTok && tokText ? dim(tokText) : '');
  const right2 = limits.map((l, i) => seg(
    gaugeOf(dim(l.label), pctColor(l.p), limPct[i], l.p,
      choice.withUntil && l.until ? dim(l.until) : ''), l.prio));
  lines.push(fit([seg(ctxSeg, 100)], right2, width));
}

process.stdout.write(lines.join('\n'));
