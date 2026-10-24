#!/usr/bin/env node
// settings.subagentStatusLine command: renders the body of every row in the agent panel
// (the subagent list under the prompt). Claude Code ticks this every ~5s with ALL visible
// rows on stdin and takes one JSON line per row on stdout:
//
//   in   { columns, tasks: [{ id, name, type, status, description, label, startTime,
//                             model, effort, contextWindowSize, tokenCount, tokenSamples, cwd }] }
//   out  {"id":"<task id>","content":"<row body>"}   (ANSI + OSC 8 render as-is)
//
// The content REPLACES the whole default row body (name . description . tokens), so it has
// to carry the name itself. Rendered as a table, because a list of agents only reads well
// when the columns line up:
//
//   explore-hooks   scanning ~/.claude/hooks     sonnet xhigh . 30k 15% .  2m . 30k/m
//   verify-payload  contract confirmed           opus 1m  500 . 90k  9% .  7m
//
// Two rules keep it a table rather than a ragged list: the stat columns are padded to a
// shared width across rows, and a column that does not fit is dropped from EVERY row at
// once (lowest priority first) instead of per row.
//
// model+effort is deliberately on every row: it is the at-a-glance check that the routing
// rule held and no agent silently inherited the session model.
// tokenSamples is the last 16 tokenCount readings ~5s apart, which is where the rate comes from.
// Fail-soft: on any error print nothing, which leaves Claude Code's default rows untouched.

const fs = require('fs');
const path = require('path');
const L = require(path.join(__dirname, 'statusline-lib.js'));
const { c, dim, bold, C, SEP, fmtNum, fmtDur, pctColor, bar, fit, vlen, trunc } = L;

const SAMPLE_INTERVAL_MS = 5000; // Claude Code's subagentStatusLine tick
const NAME_MAX = 22;
const LABEL_MIN = 10; // never squeeze the description below this before dropping a column

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; }
}

const nameOf = (t) => String(t.name || t.label || t.description || t.type || 'agent');
const isDone = (s) => s === 'completed' || s === 'failed' || s === 'killed';

function nameColor(status) {
  if (status === 'completed') return C.ok;
  if (status === 'failed' || status === 'killed') return C.bad;
  if (status === 'paused') return C.warn;
  return C.dir; // running / pending / anything still live
}

// Tokens per minute from the sample ring; only meaningful once two samples exist and the
// count has moved, so a stalled agent shows nothing rather than a stale number.
function tokenRate(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return '';
  const first = samples[0], last = samples[samples.length - 1];
  if (typeof first !== 'number' || typeof last !== 'number') return '';
  const delta = last - first;
  if (delta <= 0) return '';
  const perMin = (delta / ((samples.length - 1) * SAMPLE_INTERVAL_MS)) * 60000;
  return perMin >= 1 ? fmtNum(perMin) + '/m' : '';
}

function elapsed(startTime) {
  const t = typeof startTime === 'number' ? (startTime < 1e12 ? startTime * 1000 : startTime) : null;
  if (!t) return '';
  const ms = Date.now() - t;
  return ms > 0 && ms < 1000 * 60 * 60 * 24 * 7 ? fmtDur(ms) : '';
}

let data = {};
try { data = JSON.parse(readStdin() || '{}'); } catch (_) { process.exit(0); }

const tasks = Array.isArray(data.tasks) ? data.tasks : [];
if (!tasks.length) process.exit(0);

// `columns` is the raw terminal width, not the row body's width: every row is prefixed by a
// fixed status-glyph gutter (2 + glyph + 1 = 4 cells) plus 2 more per nesting level
// for the tree connector, and the body is truncated to whatever is left. Reserve enough for a
// nested row; over-reserving only ends the row a cell or two early.
const ROW_RESERVE = L.envInt('CLAUDE_STATUSLINE_ROW_RESERVE', 6);
const width = Math.max(30, (parseInt(data.columns, 10) || L.columns()) - ROW_RESERVE);

// ---------------------------------------------------------------- per-row cells
// Columns in drop order (lowest priority first). Each cell is {text, plain} so widths can be
// measured on the visible characters while the padded output keeps its color.
// A per-row context gauge, matching line 2 of the main status line. It only earns its cells on
// a panel wide enough to hold it next to a name, a description and the stats.
const GAUGE_W = 8;
const useGauge = width >= 72;

const COLUMNS = ['rate', 'elapsed', 'model', 'tokens'];
const DISPLAY = ['model', 'tokens', 'elapsed', 'rate'];
const ALIGN = { model: 'left', tokens: 'right', elapsed: 'right', rate: 'right' };

const rows = tasks.map((t) => {
  const done = isDone(t.status);
  const rawName = trunc(nameOf(t), NAME_MAX);
  const cells = {};

  if (t.model) {
    const eff = t.effort == null ? '' : typeof t.effort === 'number' ? fmtNum(t.effort) : String(t.effort);
    cells.model = c(L.shortModel(t.model), C.model) + (eff ? ' ' + dim(eff) : '');
  }
  if (typeof t.tokenCount === 'number' && t.tokenCount > 0) {
    const pct = t.contextWindowSize ? Math.round((t.tokenCount / t.contextWindowSize) * 100) : null;
    // Same gauge as the main status line's line 2, so a row of agents reads like the bar above
    // it. Narrow panels fall back to the bare number - a 4-cell gauge is a smear, not a gauge.
    cells.tokens = c(fmtNum(t.tokenCount), C.cost) +
      (pct == null ? ''
        : useGauge ? ' ' + bar(pct, GAUGE_W, pctColor(pct, 60, 80), pct + '%')
        : ' ' + c(pct + '%', pctColor(pct, 60, 80)));
  }
  const el = elapsed(t.startTime);
  if (el) cells.elapsed = dim(el);
  if (!done) {
    const rate = tokenRate(t.tokenSamples);
    if (rate) cells.rate = dim(rate);
  }

  return {
    id: String(t.id),
    done,
    name: c(done ? rawName : bold(rawName), nameColor(t.status)),
    nameLen: vlen(rawName),
    label: String(t.label || t.description || '').replace(/\s+/g, ' ').trim(),
    cells,
  };
});

const nameW = Math.min(NAME_MAX, rows.reduce((m, r) => Math.max(m, r.nameLen), 0));

// ---------------------------------------------------------------- shared column layout
const pad = (s, w, align) => {
  const gap = ' '.repeat(Math.max(0, w - vlen(s)));
  return align === 'right' ? gap + s : s + gap;
};

function layout(enabled) {
  const widths = {};
  for (const col of enabled) widths[col] = rows.reduce((m, r) => Math.max(m, vlen(r.cells[col] || '')), 0);
  const order = DISPLAY.filter((col) => enabled.includes(col) && widths[col] > 0);
  const render = (row) => {
    let out = '', anyBefore = false;
    for (const col of order) {
      const cell = row.cells[col] || '';
      if (out) out += anyBefore && cell ? dim(SEP) : ' '.repeat(vlen(SEP));
      out += pad(cell, widths[col], ALIGN[col]);
      if (cell) anyBefore = true;
    }
    return out;
  };
  const w = order.reduce((sum, col) => sum + widths[col], 0) + Math.max(0, order.length - 1) * vlen(SEP);
  return { render, width: w, order };
}

// Drop whole columns (cheapest first) until the stat block leaves room for name + a bit of label.
let enabled = COLUMNS.slice();
let grid = layout(enabled);
while (grid.order.length && grid.width + nameW + 2 + LABEL_MIN > width) {
  enabled = enabled.slice(1); // COLUMNS is ordered lowest priority first
  grid = layout(enabled);
}

// ---------------------------------------------------------------- emit
const out = [];
for (const row of rows) {
  try {
    const left = row.name + ' '.repeat(Math.max(0, nameW - row.nameLen)) + (row.label ? '  ' + dim(row.label) : '');
    const right = grid.render(row);
    let content = fit([{ text: left, prio: 100 }], right ? [{ text: right, prio: 100 }] : [], width);
    // Finished rows recede. SGR 2/22 do not nest, so every inner "dim off" has to re-arm the
    // row-level dim or the rest of the row would snap back to full brightness.
    if (row.done) content = '\x1b[2m' + content.split('\x1b[22m').join('\x1b[22m\x1b[2m') + '\x1b[22m';
    out.push(JSON.stringify({ id: row.id, content }));
  } catch (_) { /* leave this row's default rendering in place */ }
}

if (out.length) process.stdout.write(out.join('\n') + '\n');
