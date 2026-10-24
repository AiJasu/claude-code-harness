// Toggles the opt-in guards read by guard-hook.js. Invoked by the /careful, /freeze,
// and /guard-off slash commands; SessionStart garbage-collects stale entries.
//
// State is KEYED BY SESSION (fix for the cross-session clobber: one session's /guard-off
// or /freeze must not affect parallel sessions). Callers pass --session <session-uuid>;
// without it, state lands under the legacy 'global' key, which every session honors as a
// fallback and SessionStart clears.
//
//   node guard-ctl.js careful [--session <id>]        -> careful: true
//   node guard-ctl.js freeze [<dir>] [--session <id>] -> freeze: <dir> (default = cwd)
//   node guard-ctl.js off [--session <id>]            -> suspend guards (prints confirmation)
//   node guard-ctl.js reset [--session <id>]          -> clear this session's guards
//                                                        (no --session: clear the whole file)
//   node guard-ctl.js status [--session <id>]         -> print current guard state

const fs = require('fs');
const path = require('path');
const os = require('os');
// Home-dir relative so the same script works under any account.
const STATE = path.join(os.homedir(), '.claude', '.guard-state.json');

// Legacy flat shape ({careful/freeze/off} at top level) reads as a 'global' entry.
function readAll() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (j && (j.careful !== undefined || j.freeze !== undefined || j.off !== undefined)) return { global: j };
    return j || {};
  } catch (_) { return {}; }
}
function writeAll(all) {
  if (Object.keys(all).length === 0) { try { fs.unlinkSync(STATE); } catch (_) {} return; }
  fs.writeFileSync(STATE, JSON.stringify(all));
}

let sessionId = null;
const rest = [];
const raw = process.argv.slice(2);
for (let i = 0; i < raw.length; i++) {
  if (raw[i] === '--session') { sessionId = raw[++i] || null; continue; }
  rest.push(raw[i]);
}
const KEY = sessionId || 'global';
const cmd = (rest[0] || 'status').toLowerCase();
const arg = rest[1];
const scope = sessionId ? 'this session' : 'ALL sessions (no --session passed - legacy global scope)';

try {
  if (cmd === 'careful') {
    const all = readAll(); const e = all[KEY] || {};
    e.careful = true; delete e.off; e.ts = Date.now(); all[KEY] = e; writeAll(all);
    console.log('Guard /careful ON for ' + scope + ': destructive shell commands (rm -rf, force-push, reset --hard, DROP, etc.) are now blocked. /guard-off to lift.');
  } else if (cmd === 'freeze') {
    // Resolve to an absolute path at arm time so the fence does not drift if the
    // session cwd later differs from where /freeze was run.
    const dir = path.resolve(arg || process.cwd());
    const all = readAll(); const e = all[KEY] || {};
    e.freeze = dir; delete e.off; e.ts = Date.now(); all[KEY] = e; writeAll(all);
    console.log('Guard /freeze ON for ' + scope + ': file writes are now restricted to ' + dir + '. /guard-off to lift.');
  } else if (cmd === 'off') {
    // Sentinel (not delete): suspends the always-on catastrophic + secret-exfil blocks and
    // lifts /careful + /freeze for this key. SessionStart GC re-arms next session.
    const all = readAll(); all[KEY] = { off: true, ts: Date.now() }; writeAll(all);
    console.log('Guards lifted for ' + scope + ': /careful + /freeze off, and the always-on catastrophic-command + secret-exfil blocks are suspended until the next session. (The secret-write scan stays active.)');
  } else if (cmd === 'reset') {
    if (sessionId) { const all = readAll(); delete all[KEY]; writeAll(all); }
    else { try { fs.unlinkSync(STATE); } catch (_) {} }
  } else {
    const all = readAll(); const e = all[KEY] || {};
    const parts = [];
    if (e.off) parts.push('OFF (always-on catastrophic/exfil blocks suspended this session)');
    if (e.careful) parts.push('careful=ON');
    if (e.freeze) parts.push('freeze=' + e.freeze);
    if (sessionId && all.global && (all.global.off || all.global.careful || all.global.freeze)) {
      parts.push('[legacy global entry also present - affects all sessions until SessionStart clears it]');
    }
    console.log(parts.length ? 'Guards: ' + parts.join(', ') : 'Default: always-on secret-write scan + catastrophic-command + secret-exfil blocks active; /careful and /freeze not armed.');
  }
} catch (e) {
  console.error('guard-ctl error: ' + e.message);
  process.exit(1);
}
