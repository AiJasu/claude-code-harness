// Shared rendering helpers for the two status lines:
//   statusline.js           -> the main two-line status bar (settings.statusLine)
//   subagent-statusline.js  -> one row per subagent in the agent panel (settings.subagentStatusLine)
//
// Both surfaces render ANSI colors and OSC 8 hyperlinks as-is, so everything here is
// escape-sequence aware: widths are measured on the visible text only.
//
// GLYPHS: the block-bar + middle-dot look is deliberate, a carve-out from the global
// no-Unicode-icons rule - these are drawing characters, not icons. They are built from
// codepoints rather than typed literally so this source file stays pure ASCII (non-ASCII does
// not survive heredocs / Edit round-trips).
// Set CLAUDE_STATUSLINE_ASCII=1 for a strict-ASCII rendering in a font that lacks them.

const ASCII = process.env.CLAUDE_STATUSLINE_ASCII === '1';
const NOCOLOR = !!process.env.NO_COLOR;

const G = ASCII
  ? { dot: '|', barFull: '=', barEmpty: '-', ell: '..' }
  : {
      dot: String.fromCharCode(0x00b7),      // middle dot
      barFull: String.fromCharCode(0x2588),  // full block
      barEmpty: String.fromCharCode(0x2591), // light shade
      ell: '..',
    };

// 256-color palette, tuned for a dark theme.
const C = {
  dir: 75,     // cornflower blue
  branch: 141, // medium purple
  dirty: 179,  // tan
  model: 173,  // clay (Claude-ish)
  cost: 108,   // sage
  ok: 71,      // green
  warn: 179,   // amber
  bad: 167,    // red
  mute: 242,   // separator gray
  label: 245,  // label gray
  flag: 214,   // orange
  link: 111,   // soft blue
  name: 109,   // steel (session / agent name)
};

const c = (s, code) => (NOCOLOR || code == null ? String(s) : `\x1b[38;5;${code}m${s}\x1b[39m`);
const dim = (s) => (NOCOLOR ? String(s) : `\x1b[2m${s}\x1b[22m`);
const bold = (s) => (NOCOLOR ? String(s) : `\x1b[1m${s}\x1b[22m`);

// Strip SGR sequences and OSC 8 link wrappers so widths measure what the eye sees.
const strip = (s) =>
  String(s)
    .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;]*m/g, '');
const vlen = (s) => strip(s).length;

// ANSI-aware truncation: keeps escape sequences intact, cuts only visible characters.
function trunc(s, max) {
  if (max <= 0) return '';
  if (vlen(s) <= max) return s;
  const keep = Math.max(0, max - G.ell.length);
  let out = '', seen = 0, i = 0;
  const str = String(s);
  while (i < str.length && seen < keep) {
    if (str[i] === '\x1b') {
      const m = /^\x1b(?:\[[0-9;]*m|\]8;;[^\x07\x1b]*(?:\x07|\x1b\\))/.exec(str.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    out += str[i]; i++; seen++;
  }
  return out + (NOCOLOR ? '' : '\x1b[0m') + G.ell;
}

// trimWords() lived here to shorten AI-generated session titles on a word boundary. The status
// row no longer renders those titles (the folder and the branch took that spot),
// and every remaining label is an identity string - dir, branch, worktree, agent - which keeps
// trunc(): a silently shortened branch name is worse than an obviously shortened one.

const osc8 = (url, text) =>
  NOCOLOR || !url ? text : `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

// 12345 -> 12k, 1234567 -> 1.2M. Used for token counts and context window sizes.
function fmtNum(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
  if (n >= 1000000) { const v = n / 1000000; return (v >= 10 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')) + 'M'; }
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(Math.round(n));
}

// Wall-clock durations: 45s / 12m / 1h07m / 2d3h.
function fmtDur(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
  let s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// Time remaining until a Unix-epoch-seconds deadline (rate limit resets).
function fmtUntil(epochSec) {
  if (typeof epochSec !== 'number' || !isFinite(epochSec)) return '';
  const left = epochSec * 1000 - Date.now();
  return left <= 0 ? '' : fmtDur(left);
}

// Threshold coloring: green below warn, amber below bad, red at/above bad.
const pctColor = (p, warn = 70, bad = 90) => (p >= bad ? C.bad : p >= warn ? C.warn : C.ok);

// claude-opus-5[1m] -> "opus 1m"; claude-sonnet-5 -> "sonnet"; unknown ids pass through short.
function shortModel(id) {
  const s = String(id || '');
  const fam = /(fable|opus|sonnet|haiku)/i.exec(s);
  if (!fam) return s.length > 14 ? s.slice(0, 14) : s;
  const long = /\[1m\]|-1m\b/i.test(s) ? ' 1m' : '';
  return fam[1].toLowerCase() + long;
}

// A label can sit inside a bar only if at least one cell survives on each side of it.
const canInline = (label, width) => !!label && String(label).length + 2 <= Math.floor(width);

// Bar rendering: 'bg' paints the gauge as a background color so the percentage sits ON the
// bar; 'blocks' draws it with block characters and punches the percentage through them.
// Background mode needs color, so NO_COLOR falls back to blocks on its own.
const BAR_MODE = process.env.CLAUDE_STATUSLINE_BAR === 'blocks' || NOCOLOR ? 'blocks' : 'bg';
const BG_EMPTY = 238;  // dark gray trough
const FG_ON_FILL = 16; // near-black, for the label where it crosses the filled run
const FG_ON_EMPTY = 252;

// Solid/shaded progress bar. pct is 0-100; width is in cells. An optional `label` is written
// INTO the middle of the bar (the cells it covers become the label's characters), which is why
// callers hand the bar the cells the outside label would have used - the row width is the same
// either way. The label is bold so it reads against both the filled and the empty run.
function bar(pct, width, code, label) {
  const w = Math.max(1, Math.floor(width));
  const p = Math.max(0, Math.min(100, typeof pct === 'number' && isFinite(pct) ? pct : 0));
  // Any non-zero usage keeps at least one filled cell: on a short bar 2% rounds to nothing,
  // which reads as a broken bar rather than as "barely used".
  let filled = Math.round((p / 100) * w);
  if (p > 0 && filled === 0) filled = 1;

  const lab = canInline(label, w) ? String(label) : '';
  if (BAR_MODE === 'blocks' && !lab) {
    return c(G.barFull.repeat(filled), code) + c(G.barEmpty.repeat(w - filled), C.mute);
  }
  if (!lab && BAR_MODE !== 'blocks') {
    // Empty gauge, background mode: just the two colored runs, nothing written on them.
    return `\x1b[48;5;${code}m` + ' '.repeat(filled) + `\x1b[48;5;${BG_EMPTY}m` +
      ' '.repeat(w - filled) + '\x1b[49m';
  }

  const start = Math.max(0, Math.round((w - lab.length) / 2));
  let out = '', run = '', runKind = null;
  const flush = () => {
    if (!run) return;
    if (BAR_MODE === 'blocks') {
      out += runKind === 'label' ? bold(c(run, code)) : c(run, runKind === 'fill' ? code : C.mute);
    } else {
      // The gauge is the BACKGROUND and the label sits on top of it, so the label's foreground
      // has to flip where it crosses from the filled run onto the trough.
      const onFill = runKind === 'fill' || runKind === 'labelFill';
      const bg = `\x1b[48;5;${onFill ? code : BG_EMPTY}m`;
      const fg = runKind === 'labelFill' ? `\x1b[1m\x1b[38;5;${FG_ON_FILL}m`
        : runKind === 'labelEmpty' ? `\x1b[1m\x1b[38;5;${FG_ON_EMPTY}m` : '';
      out += bg + fg + run + (fg ? '\x1b[22m\x1b[39m' : '') + '\x1b[49m';
    }
    run = '';
  };
  for (let i = 0; i < w; i++) {
    const inLabel = i >= start && i < start + lab.length;
    const onFill = i < filled;
    const kind = inLabel ? (onFill ? 'labelFill' : 'labelEmpty') : onFill ? 'fill' : 'empty';
    if (kind !== runKind) { flush(); runKind = kind; }
    if (BAR_MODE === 'blocks') run += inLabel ? lab[i - start] : onFill ? G.barFull : G.barEmpty;
    else run += inLabel ? lab[i - start] : ' ';
  }
  flush();
  return out;
}

const SEP = ` ${G.dot} `;
const joinSegs = (segs) => segs.filter((s) => s && s.text).map((s) => s.text).join(NOCOLOR ? SEP : dim(SEP));

// Fit a left group and a right group onto one row of `width` cells: the right group is
// pushed to the right edge, and when the row overflows the lowest-priority segments are
// dropped first (priority 100 = never dropped). Falls back to hard truncation.
function fit(left, right, width) {
  const L = left.filter(Boolean).slice();
  const R = right.filter(Boolean).slice();
  const build = () => {
    const l = joinSegs(L), r = joinSegs(R);
    return { l, r, w: vlen(l) + vlen(r) + (r ? 2 : 0) };
  };
  let s = build();
  while (s.w > width) {
    const all = [
      ...L.map((x, i) => ({ side: 'L', i, p: x.prio })),
      ...R.map((x, i) => ({ side: 'R', i, p: x.prio })),
    ].filter((x) => x.p < 100).sort((a, b) => a.p - b.p);
    if (!all.length) break;
    const drop = all[0];
    if (drop.side === 'L') L.splice(drop.i, 1); else R.splice(drop.i, 1);
    s = build();
  }
  if (s.w > width) {
    const rw = vlen(s.r);
    return rw + 2 <= width ? trunc(s.l, width - rw - 1) + ' ' + s.r : trunc(s.l, width);
  }
  const pad = Math.max(1, width - vlen(s.l) - vlen(s.r));
  return s.r ? s.l + ' '.repeat(pad) + s.r : s.l;
}

// COLUMNS is the full terminal width, but neither status surface gets all of it: the TUI
// renders both inside an inset container and truncates (with its own ellipsis) anything wider
// than the space that is actually left. Nothing in the payload reports that inset, so both
// callers subtract a reserve. Too small and the line gets an ellipsis; too large and the
// right-hand group just floats a few cells short of the edge - so the default errs large.
const columns = (reserve = 0) => {
  const n = parseInt(process.env.COLUMNS, 10);
  const w = isFinite(n) && n > 20 ? n : 100;
  return Math.max(30, w - reserve);
};
const envInt = (name, fallback) => {
  const n = parseInt(process.env[name], 10);
  return isFinite(n) && n >= 0 ? n : fallback;
};

module.exports = {
  ASCII, NOCOLOR, G, C, SEP,
  c, dim, bold, strip, vlen, trunc, osc8,
  fmtNum, fmtDur, fmtUntil, pctColor, shortModel, bar, canInline, fit, joinSegs, columns, envInt,
};
