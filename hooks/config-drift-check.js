// SessionStart config-drift check. Stance: no MCP servers beyond CLAUDE_MCP_ALLOW, hooks only from
// ~/.claude/hooks, no API endpoint/proxy overrides. A malicious npm package or hook can reseed
// ~/.claude.json / settings.json and survive token rotation. This prints a warning into session
// context on drift; it never blocks and fails open.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const warn = [];
const STATE_PATH = path.join(HOME, '.claude', '.config-drift-seen.json');
// Default/reset value for the (a) escalation ratchet's ledger slice - overwritten below only when
// rule (a)'s predicate runs. Kept at top scope so a throw inside the main try still leaves the
// heartbeat write something safe to serialize.
let escalationLedger = { consecutiveCount: 0, firstSeenIso: null, lastEscalatedIso: null };
const ESCALATION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// TWO INDEPENDENT RULES, deliberately separate: accepting "no explicit pin" must not disable
// the escalation guard with it.
//
//   (a) ESCALATION LEAK - always on, whatever the baseline. An in-session `/model fable` SAVES
//       its pick, so a single escalation silently becomes the default for every NEW session and
//       bills the weekly Fable cap. This check exists to catch that.
//   (b) BASELINE - which model new sessions should start on. MODEL_PIN = 'default' means the key
//       is EXPECTED to be absent, so the CLI default applies and tracks model upgrades on its
//       own; a concrete id (e.g. 'claude-opus-5') means the key must be present and match.
//
// Baseline is 'default' because an absent key resolves to the CLI default and auto-tracks the
// next model without a manual bump. CAVEAT: the /model Default row can follow the last SAVED
// pick, so an absent key does not guarantee the non-escalation tier - arm (a2) below watches for
// that. Set CLAUDE_MODEL_PIN to a concrete id to go back to pinning, or to '' to disable ALL
// model arms.
//
// `??` not `||`: under `||` an explicitly EMPTY value fell back to the default and the opt-out
// the warning text advertises did nothing (caught by tests/config-drift-fixtures.js).
const MODEL_PIN = process.env.CLAUDE_MODEL_PIN ?? 'default';
// `/model fable` --save writes the BARE alias "fable" to settings.json, not "claude-fable-...",
// so the pattern is unanchored: matches "fable" anywhere, case-insensitive. Safe to be broad -
// this field only ever holds a model id, and no non-Fable id contains "fable".
const ESCALATION_TIER = /fable/i;

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^[^{]+/, '')); } catch (_) { return null; }
}

// SessionStart payload on stdin; only `source` and `model` are read, by arm (a2). Skipped on a TTY
// so a manual `node config-drift-check.js` does not wait for EOF; empty or unparsable stdin (the
// fixtures' default, an older CLI) reads as {} and (a2) stays silent. Fails open.
function readStartPayload() {
  try { return process.stdin.isTTY ? {} : (JSON.parse(fs.readFileSync(0, 'utf8') || '{}') || {}); } catch (_) { return {}; }
}
const START = readStartPayload();

try {
  // 1. ~/.claude.json: no MCP server entries anywhere (top-level or per-project), except the names
  //    listed in CLAUDE_MCP_ALLOW (comma-separated) - the servers you added on purpose.
  const cj = readJson(path.join(HOME, '.claude.json')) || {};
  const MCP_ALLOW = new Set(String(process.env.CLAUDE_MCP_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean));
  const unknown = (servers) => Object.keys(servers || {}).filter((n) => !MCP_ALLOW.has(n));
  const mcp = [];
  if (unknown(cj.mcpServers).length) mcp.push(`top-level: ${unknown(cj.mcpServers).join(', ')}`);
  for (const [proj, cfg] of Object.entries(cj.projects || {})) {
    if (cfg && unknown(cfg.mcpServers).length) mcp.push(`${proj}: ${unknown(cfg.mcpServers).join(', ')}`);
  }
  if (mcp.length) warn.push(`MCP server entries in ~/.claude.json not listed in CLAUDE_MCP_ALLOW: ${mcp.join(' | ')}`);

  // 2. Settings files: hook + statusline commands must point into a .claude/hooks dir
  //    (account-agnostic, so the same script passes for any user), no proxy/endpoint env,
  //    no routing-clobber env, no command-executing helper keys. Covers user settings AND
  //    the current project's settings files (a cloned repo can reseed hooks there; settings.local.json
  //    can resolve to the git repo root rather than cwd, so check both cwd and root).
  // Exec-form bindings put the script path in args, not command - test the whole invocation.
  const inHooksDir = (h) => [h && h.command, ...((h && h.args) || [])].join(' ')
    .replace(/\\/g, '/').toLowerCase().includes('/.claude/hooks/');
  const BAD_ENV = /^(ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|HTTPS?_PROXY|ALL_PROXY|NODE_EXTRA_CA_CERTS|CLAUDE_CODE_SUBAGENT_MODEL|CLAUDE_CODE_EFFORT_LEVEL|CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH)$/i;
  const EXEC_KEYS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'];
  // What a command runs, never the whole line: arguments and env prefixes can carry tokens.
  // The basename of the first script-like token, else of the first word that is not an X=Y prefix.
  const runs = (h) => {
    const line = [h.command, ...(h.args || [])].join(' ');
    const script = /[^\s'"=]+\.(?:js|mjs|cjs|ts|py|ps1|sh|bat|cmd|exe)\b/i.exec(line);
    const first = line.split(/\s+/).find((w) => w && !w.includes('='));
    return path.basename(String((script && script[0]) || first || '?').replace(/['"]/g, '').replace(/\\/g, '/'));
  };
  function checkSettings(p, tag) {
    const sj = readJson(p);
    if (!sj) return;
    for (const [event, matchers] of Object.entries(sj.hooks || {})) {
      for (const m of matchers || []) {
        for (const h of (m && m.hooks) || []) {
          if (h && h.command && !inHooksDir(h)) warn.push(`unfamiliar hook command under ${event} in ${tag}: runs ${runs(h)}`);
        }
      }
    }
    if (sj.statusLine && sj.statusLine.command && !inHooksDir(sj.statusLine)) {
      warn.push(`unfamiliar statusLine command in ${tag}: runs ${runs(sj.statusLine)}`);
    }
    // Key names only: these values can be a token, a proxy URL with user:pass, or a helper
    // command line, and the warning lands in session context.
    for (const k of Object.keys(sj.env || {})) {
      if (BAD_ENV.test(k)) warn.push(`proxy/endpoint/routing-clobber env in ${tag}: ${k} is set`);
    }
    for (const k of EXEC_KEYS) {
      if (sj[k]) warn.push(`command-executing key ${k} is set in ${tag}`);
    }
  }
  checkSettings(path.join(HOME, '.claude', 'settings.json'), 'user settings.json');

  // 3. (d) AUTO MODE (expected default permission mode). A non-empty autoMode list in user
  //     settings REPLACES the built-in classifier rules unless it contains the literal "$defaults";
  //     project/local autoMode blocks are ignored by the CLI itself. Report only.
  {
    const us = readJson(path.join(HOME, '.claude', 'settings.json')) || {};
    const am = (us.autoMode && typeof us.autoMode === 'object') ? us.autoMode : {};
    for (const k of ['allow', 'soft_deny', 'hard_deny', 'environment']) {
      if (Array.isArray(am[k]) && am[k].length && !am[k].includes('$defaults')) {
        warn.push(`autoMode.${k} in user settings.json has no "$defaults" entry, so it REPLACES the built-in ${k} rules`);
      }
    }
    // bypassPermissions skips every prompt, so it is always worth saying. Any other mode is the
    // user's pick; set CLAUDE_EXPECT_DEFAULT_MODE (e.g. auto) to be told when it drifts from yours.
    const mode = us.permissions && us.permissions.defaultMode;
    const expected = process.env.CLAUDE_EXPECT_DEFAULT_MODE || '';
    if (mode === 'bypassPermissions') {
      warn.push('permissions.defaultMode in user settings.json is bypassPermissions: every permission prompt is skipped');
    } else if (expected && mode !== expected) {
      warn.push(`permissions.defaultMode in user settings.json is ${mode || 'unset'}, not ${expected} (CLAUDE_EXPECT_DEFAULT_MODE)`);
    }
  }

  // 4. Model pin: the live default in user settings.json vs the intended one.
  const userSettings = readJson(path.join(HOME, '.claude', 'settings.json'));
  // (a) Escalation leak. Independent of the baseline: finding Fable SAVED as the default is worth
  // SAYING whatever the baseline is, because a fan-out that omits a model would inherit it.
  //
  // WHAT THIS ARM MUST NOT DO: advise deleting the model key. The key is the user's own pick;
  // this arm reports and stops. The real protection is the rule that every Agent call and every
  // workflow agent() names its own model, enforced by model-routing-guard.js.
  //
  // RATCHET. A warning that fires every session and never becomes an ask is invisible. Sighting 1
  // stays the passive line below. Sighting 2+ upgrades the text into an instruction to act on it
  // in the reply, then this arm goes quiet for 7 days, so a permanently-red condition does not
  // train the reader to ignore the channel.
  if (userSettings && MODEL_PIN && ESCALATION_TIER.test(String(userSettings.model || ''))) {
    let prevBeat = {};
    try { prevBeat = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) || {}; } catch (_) { prevBeat = {}; }
    const prevEsc = (prevBeat && prevBeat.escalation) || {};
    const now = Date.now();
    const consecutive = (prevEsc.consecutiveCount > 0 ? prevEsc.consecutiveCount : 0) + 1;
    const firstSeenIso = (prevEsc.consecutiveCount > 0 && prevEsc.firstSeenIso) || new Date(now).toISOString();
    const inCooldown = !!(prevEsc.lastEscalatedIso && (now - Date.parse(prevEsc.lastEscalatedIso)) < ESCALATION_COOLDOWN_MS);
    let lastEscalatedIso = prevEsc.lastEscalatedIso || null;
    if (consecutive === 1) {
      warn.push(`model default is the ESCALATION tier: settings.json model = ${userSettings.model}. ` +
        'An in-session /model SAVES its pick, so every NEW session starts on Fable and bills the ' +
        "weekly cap. That is the USER'S PICK, not drift - never delete the \"model\" key and never offer to. " +
        'Mention it only if it bears on the task. What protects the cap is the fan-out rule: Fable ' +
        'is per-session, so every Agent call and every workflow agent() names its own model.');
    } else if (!inCooldown) {
      warn.push(`model default is STILL the ESCALATION tier after ${consecutive} consecutive sessions ` +
        `(first seen ${firstSeenIso.slice(0, 10)}): settings.json model = ${userSettings.model}. ACT ON ` +
        'THIS in your first reply this turn: state the consecutive-session count and the first-seen ' +
        'date so it is not invisible, then LEAVE THE KEY ALONE - deleting it, or offering to, is ' +
        'ruled out. Check instead that nothing is INHERITING it: Fable is ' +
        'per-session, so every Agent call and every workflow agent() names its own model.');
      lastEscalatedIso = new Date(now).toISOString();
    }
    // else: inCooldown - silent for THIS arm, THIS run only (other arms are unaffected). The
    // condition is still drift and the ledger below still tracks it, so the count resumes and the
    // next post-cooldown sighting reports the true total rather than restarting at 2.
    escalationLedger = { consecutiveCount: consecutive, firstSeenIso, lastEscalatedIso };
  } else if (userSettings && MODEL_PIN === 'default') {
    // (b) Baseline = 'default': the intended state is NO key at all, so ANY explicit key is drift
    // by definition. This deliberately replaces an earlier tier list that only knew about Fable
    // and let a stray `/model haiku` become the permanent default in silence. Testing against the
    // intended state instead of against a list of bad values means an unforeseen model id is
    // caught too, and there is nothing to keep up to date.
    if (userSettings.model) {
      warn.push(`model default is PINNED but the baseline is the CLI default: settings.json model = ` +
        `${userSettings.model}. An in-session /model SAVES its pick, so this is now the default for ` +
        'every NEW session - and it stops tracking model upgrades. Pick the default entry in /model ' +
        '(it deletes the key), or set CLAUDE_MODEL_PIN to this id if the pin is deliberate.');
    }
  } else if (userSettings && MODEL_PIN) {
    // (b) Baseline = a concrete model id: the key must be present and match.
    if (!userSettings.model) {
      warn.push(`model pin ABSENT: settings.json has no "model" key, intended default = ${MODEL_PIN}. ` +
        'Choosing the "(default)" entry in /model deletes the key rather than writing it, so new ' +
        `sessions follow the CLI default instead of the pin. Restore by adding "model": "${MODEL_PIN}" ` +
        "to ~/.claude/settings.json, or set CLAUDE_MODEL_PIN='default' if the CLI default is intended.");
    } else if (!String(userSettings.model).startsWith(MODEL_PIN)) {
      warn.push(`model pin drifted: settings.json model = ${userSettings.model}, intended default = ${MODEL_PIN}. ` +
        'An in-session /model SAVES its pick, so every NEW session inherits it. Restore with /model opus; ' +
        'if the change is deliberate, edit MODEL_PIN in this hook or set CLAUDE_MODEL_PIN.');
    }
  }
  // (a2) Escalation leak WITHOUT a key. Picking the /model Default row after an earlier
  // `/model fable` save can remove the key while new sessions still start on Fable, which arm (a)
  // cannot see. No local file records what Default resolves to; the one free signal is the
  // SessionStart payload's `model` on a FRESH start that passed no --model. startup only - on
  // resume/compact/fork/clear it is the session's current model, which may be a legitimate
  // per-session `/model fable`. Passive wording like arm (a) sighting 1; at most once per fresh
  // start, so no ratchet. Pre-colon clause carries no model id (the heartbeat ledger stores it).
  if (userSettings && MODEL_PIN && !userSettings.model && START.source === 'startup' &&
      ESCALATION_TIER.test(String(START.model || ''))) {
    warn.push('model default resolves to the ESCALATION tier with no "model" key: this new session ' +
      `started on ${START.model}. The /model Default row can follow the last SAVED pick, so choosing ` +
      'Default after a /model fable save keeps Fable for every NEW session and bills the weekly cap. ' +
      'If unintended: /model opus (Enter saves), then /model and pick Default. Ignore if this session ' +
      "was started with --model fable. The model is the user's pick - mention it only if it bears on " +
      'the task; every Agent call and workflow agent() still names its own model.');
  }
  const cwd = process.cwd();
  let gitRoot = null;
  for (let d = cwd, i = 0; i < 30; i++) {
    if (fs.existsSync(path.join(d, '.git'))) { gitRoot = d; break; }
    const up = path.dirname(d); if (up === d) break; d = up;
  }
  const projDirs = [...new Set([cwd, gitRoot].filter(Boolean))];
  for (const d of projDirs) {
    checkSettings(path.join(d, '.claude', 'settings.json'), `project settings.json (${d})`);
    checkSettings(path.join(d, '.claude', 'settings.local.json'), `project settings.local.json (${d})`);
  }

  // 5. A repo-local core.hooksPath silently overrides a global one. If you use a global git-hooks
  //    dir (for example a commit-msg hook that strips attribution trailers), it does not run in
  //    that repo. Repos that genuinely need their own hooks go in HOOKSPATH_EXEMPT (basename, lowercase).
  const HOOKSPATH_EXEMPT = [];
  if (gitRoot && !HOOKSPATH_EXEMPT.includes(path.basename(gitRoot).toLowerCase())) {
    try {
      const { execFileSync } = require('child_process');
      const g = (args) => {
        try {
          return execFileSync('git', ['-C', gitRoot, 'config', ...args], {
            encoding: 'utf8', timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
        } catch (_) { return ''; }
      };
      const local = g(['--local', '--get', 'core.hooksPath']);
      const global = g(['--global', '--get', 'core.hooksPath']);
      if (local && local !== global) {
        warn.push(`repo-local core.hooksPath in ${gitRoot} (= ${local}) overrides the global git-hooks dir ` +
          `(= ${global || 'unset'}): a global git hook (e.g. a commit-msg hook) does not run here. ` +
          'Fix, if you rely on one: git config --local --unset core.hooksPath.');
      }
    } catch (_) { /* fail open */ }
  }
} catch (_) { /* fail open */ }

// (c) AUTO-COMPACT WINDOW. For a model whose context window is >=1,000,000 tokens, the "auto"
// default falls through to the model's own ceiling, so automatic compaction may never happen
// before very long, expensive turns. Two different surfaces configure this: the settings.json
// top-level "autoCompactWindow" number (editable from /config) and the
// CLAUDE_CODE_AUTO_COMPACT_WINDOW env var (wins when both are set AND locks that dialog). The
// CLI warns that overriding "auto" can raise token usage on a RESUMED long session, which is why
// this only asks for a number at or under 400000, not the lowest value that would parse. This is
// a settings check, same shape as rule (b), just a different key.
try {
  const userSettings = readJson(path.join(HOME, '.claude', 'settings.json'));
  const AUTO_COMPACT_MAX = 400000;
  const envRaw = userSettings && userSettings.env && userSettings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  const settingsRaw = userSettings && userSettings.autoCompactWindow;
  const envIsSet = envRaw !== undefined && envRaw !== null && envRaw !== '';
  // The env var outranks the settings key when both are present (matches the CLI's own resolver
  // order), so the EFFECTIVE value - the one that actually governs compaction - is the env var's
  // whenever it is set, even if the settings key alone would look fine.
  const raw = envIsSet ? envRaw : settingsRaw;
  const source = envIsSet ? 'CLAUDE_CODE_AUTO_COMPACT_WINDOW' : 'the settings.json "autoCompactWindow" key';
  const isSet = raw !== undefined && raw !== null && raw !== '';
  const n = Number(raw);
  if (userSettings && !isSet) {
    warn.push('Neither the settings.json "autoCompactWindow" key nor CLAUDE_CODE_AUTO_COMPACT_WINDOW ' +
      'is set: on a >=1M-token context model the built-in auto-compact default resolves to the full ' +
      'context window (no headroom), so compaction only happens when someone types /compact by hand - ' +
      'usually near the end of a long session, after the expensive over-400K turns already ran. Prefer ' +
      'the settings.json key, e.g. "autoCompactWindow": 300000 - it stays editable from /config, unlike ' +
      'the env var, which takes precedence and locks that dialog.');
  } else if (userSettings && isSet && (!Number.isFinite(n) || n > AUTO_COMPACT_MAX)) {
    warn.push(`${source} is ${raw}, above the ${AUTO_COMPACT_MAX} target: an unattended session can ` +
      'still run well past the point where turns start costing roughly double. Lower it.');
  }
} catch (_) { /* fail open */ }

// (e) SAVED EFFORT DIFFERS FROM THE TOP-LEVEL DEFAULT. `/effort` SAVES its pick per model into
// modelSettings, so a mid-session `/effort xhigh` silently outranks the top-level effortLevel for
// every NEW session on that model, and a plain Agent call that names a model but no effort
// inherits it. REPORT ONLY: the keys are the user's pick, so this never rewrites them and never
// offers to reset them (same stance as rule (a)). Positive evidence only: a top-level string
// effortLevel AND a string effortLevel in a modelSettings entry that differs; anything else (no
// modelSettings, no top-level key, a malformed entry) is silent. Speaks once per CHANGE of the
// differing values, using a hash of them in the heartbeat ledger (never the model id), and
// re-arms once the values agree again.
let effortLedger = { sig: null };
try {
  const us = readJson(path.join(HOME, '.claude', 'settings.json'));
  const top = us && typeof us.effortLevel === 'string' && us.effortLevel ? us.effortLevel : null;
  const saved = us && us.modelSettings && typeof us.modelSettings === 'object' ? us.modelSettings : {};
  const differing = [];
  for (const [id, cfg] of Object.entries(saved)) {
    const lvl = cfg && typeof cfg === 'object' ? cfg.effortLevel : null;
    if (top && typeof lvl === 'string' && lvl && lvl !== top) differing.push(`${id}=${lvl}`);
  }
  if (differing.length) {
    const sig = require('crypto').createHash('sha1').update(`${top}|${differing.join(',')}`).digest('hex').slice(0, 12);
    let prevSig = null;
    try {
      const prev = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) || {};
      prevSig = prev.effort && prev.effort.sig ? prev.effort.sig : null;
    } catch (_) { prevSig = null; }
    if (sig !== prevSig) {
      warn.push(`effortLevel mismatch (report only): top-level effortLevel is ${top} but modelSettings ` +
        `saves ${differing.join(', ')}. /effort saves its pick PER MODEL, so new sessions on that model ` +
        'start at the saved level, and a plain Agent call that names a model but no effort inherits it. ' +
        'Name effort on subagents (high for judgment and critic work, medium for ports, sweeps and ' +
        "transcription). The keys are the user's pick: never rewrite them and never offer to reset " +
        'them. Said once per change of these values.');
    }
    effortLedger = { sig };
  }
} catch (_) { /* fail open */ }

// HEARTBEAT. This check is SILENT on a clean config, which is the state it
// is in almost every session - so "it ran and found no drift" and "the SessionStart wiring never
// invoked it" had exactly one appearance. Same reason wf-concurrency.js and reply-lint.js keep
// ledgers. Written on EVERY run, before the warning is printed, and never allowed to throw.
try {
  fs.writeFileSync(STATE_PATH, JSON.stringify({
    _lastFired: new Date().toISOString(),
    warnings: warn.length,
    // The warning TEXT can name paths and env values; only the leading clause is kept, which is
    // enough to say which arm spoke without turning the ledger into a config dump.
    arms: warn.map((w) => String(w).split(':')[0]).slice(0, 8),
    // Consecutive-sighting ratchet for rule (a). Counts and ISO
    // timestamps only - never the model id, so the ledger cannot leak a settings value.
    escalation: escalationLedger,
    // Rule (e): a hash of the differing effort values, so a repeat run stays quiet (no ids/values).
    effort: effortLedger,
  }, null, 2));
} catch (_) { /* never let the ledger break the check */ }

if (warn.length) {
  process.stdout.write('config-drift-check WARNING (verify these are intentional):\n- ' + warn.join('\n- ') + '\n');
}
process.exit(0);
