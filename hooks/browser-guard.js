// PreToolUse hook for the browser tool family (matcher: mcp__claude-in-chrome__.*).
//
// Browser automation is the one tool family that mutates state - inside the user's own
// authenticated accounts - with no record and no guard: the shell guard sees commands, this
// sees clicks. Three jobs, in order of how much they cost:
//
//   1. LOG (always): one append-only line per STATE-CHANGING call to ~/.claude/browser-actions.log
//      - timestamp, session, tool, action, tabId, host. Reads nothing, blocks nothing.
//   2. WARN (sensitive hosts): when the call acts on a registrar / cloud console / billing or
//      account-settings host, ride one line back on additionalContext (the channel that reaches
//      the model): screenshot first, say what you will change, do not open credential fields.
//      Past 3 calls on that host the line is REPLACED by the volume note, which counts
//      EVERY call including the screenshots - the half of the traffic that carries the bytes.
//   3. BLOCK (opt-in): only if ~/.claude/browser-write-allowlist.txt exists. A state-changing
//      call whose host is not listed there is blocked with the host named, so authorizing a
//      dashboard is a one-line edit the user makes once. No file, no blocking.
//
// The host of a click is not in its own arguments, so the last navigated host per session is
// cached in ~/.claude/.browser-host-<session>.json (a separate file on purpose: .guard-state.json
// is owned by guard-ctl.js and must not be written from here).
//
// Contract: block = stderr + exit 2. Anything else = exit 0. Any internal error = exit 0.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const LOG = path.join(HOME, '.claude', 'browser-actions.log');
const ALLOWLIST = path.join(HOME, '.claude', 'browser-write-allowlist.txt');

const MUTATING_ACTIONS = /^(?:type|key|left_click|right_click|middle_click|double_click|triple_click|left_click_drag|drag|scroll)$/i;

// Calls on a sensitive host that keep the original account-panel wording. Past this the volume
// note replaces it. Three, not one: a short look-and-act at a console is the normal case and
// must not be lectured about context; a long drive through a console is what costs tokens.
const CALLS_BEFORE_VOLUME_NOTE = 3;

// Two lists, because the two kinds of entry can only be matched two different ways.
// Testing the whole URL let every entry match anywhere in a path or query, so a
// redirector at https://example.com/go?next=github.com/settings warned and NAMED THE WRONG HOST -
// and any page whose path merely says "billing" did too. A warning that fires on a foreign host
// is the one that teaches the reader to skip it, which costs the real account-panel warning.
const SENSITIVE_HOST = /(?:cloudflare|aws\.amazon|console\.cloud|portal\.azure|paypal|stripe|billing|registrar)/i;
// Entries that only mean anything WITH their path. Matched as a genuine host+path prefix.
const SENSITIVE_PATH = ['github.com/settings', 'gitlab.com/-/user_settings', 'slack.com/apps'];

// Host only: userinfo, port, query and fragment stay out, since the host is cached and logged
// (https://app.example.com?code=X has no path, so a bare "up to /" would keep the code).
function hostOf(u) {
  const m = /^[a-z]+:\/\/(?:[^@/\s?#]*@)?([^/\s?#:]+)/i.exec(String(u || ''));
  return m ? m[1].toLowerCase() : null;
}

// Path of a URL, without query or fragment; '' when the string is not a URL (e.g. a cached
// bare host), which is exactly when no path entry may match.
function pathOf(u) {
  const m = /^[a-z]+:\/\/[^/?#\s]+([^?#\s]*)/i.exec(String(u || ''));
  return m ? m[1].toLowerCase() : '';
}

// A path entry matches only as a host+path PREFIX: the host is that host (or a subdomain of it,
// the same rule the allowlist uses) and the path is that path or a segment below it. So
// github.com/settings/tokens matches, github.com/anthropics does not, and a foreign host carrying
// the token in its own path or query never does.
function sensitiveUrl(host, url) {
  if (!host) return false;
  if (SENSITIVE_HOST.test(host)) return true;
  const p = pathOf(url);
  if (!p) return false;
  return SENSITIVE_PATH.some((entry) => {
    const cut = entry.indexOf('/');
    const eHost = entry.slice(0, cut);
    const ePath = entry.slice(cut);
    if (host !== eHost && !host.endsWith('.' + eHost)) return false;
    return p === ePath || p.startsWith(ePath + '/');
  });
}

const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  let notice = '';
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const tool = String(input.tool_name || '');
    const ti = input.tool_input || {};
    const session = String(input.session_id || 'unknown').replace(/[^\w.-]/g, '_');
    const hostFile = path.join(HOME, '.claude', `.browser-host-${session}.json`);
    const short = tool.replace(/^mcp__claude-in-chrome__/, '');

    // Remember the last navigated host so later clicks in the same session know where they land.
    // Origin+path is cached alongside it because some SENSITIVE entries carry a PATH
    // (e.g. github.com/settings) and could never match a bare host. Never the query, fragment or
    // user:pass@: those can carry OAuth codes and tokens, and the file outlives the session.
    // The allowlist still keys on the HOST alone; only the warning reads paths.
    let cached = {};
    try { cached = JSON.parse(fs.readFileSync(hostFile, 'utf8')) || {}; } catch (_) {}

    let host = hostOf(ti.url);
    let where = String(ti.url || '');
    if (!host) { host = cached.host; where = cached.url || cached.host || ''; }

    // The call count lives OUT here rather than in the mutating branch: screenshots carry most of
    // the bytes of a long drive through a console but are not state-changing, so keying only on
    // the mutating-action list left them unseen. Counting every call that lands on a sensitive
    // host covers them. The cost being guarded is context, not clock.
    const onSensitive = sensitiveUrl(host, where);
    const calls = (typeof cached.calls === 'number' ? cached.calls : 0) + (onSensitive ? 1 : 0);
    if (host) {
      try { fs.writeFileSync(hostFile, JSON.stringify({ host, url: where.replace(/[?#].*$/s, '').replace(/^([a-z]+:\/\/)[^@/\s]*@/i, '$1'), calls, ts: Date.now() })); } catch (_) {}
    }

    const action = String(ti.action || ti.type || '');
    const mutating =
      short === 'form_input' || short === 'file_upload' || short === 'javascript_tool' ||
      short === 'upload_image' || short === 'navigate' ||
      (short === 'computer' && MUTATING_ACTIONS.test(action)) ||
      (short === 'browser_batch' && /form_input|file_upload|javascript_tool|"type"|left_click/.test(JSON.stringify(ti)));

    if (mutating) {
      try {
        fs.appendFileSync(LOG, [
          new Date().toISOString(), session, short, action || '-',
          ti.tabId != null ? `tab${ti.tabId}` : '-', host || '-',
        ].join(' ') + '\n');
      } catch (_) {}

      // 3. opt-in allowlist
      let allow = null;
      try { allow = fs.readFileSync(ALLOWLIST, 'utf8'); } catch (_) {}
      if (allow !== null) {
        const listed = allow.split('\n').map((l) => l.trim().toLowerCase())
          .filter((l) => l && !l.startsWith('#'));
        if (!host || !listed.some((l) => host === l || host.endsWith('.' + l))) {
          process.stderr.write(
            `browser-guard: state-changing browser call on ${host || 'an unknown host'}, which is not in\n` +
            `~/.claude/browser-write-allowlist.txt. Add the host on its own line to authorize it, or\n` +
            `say in your reply what you would change there and let the user decide.`
          );
          process.exit(2);
        }
      }
    }

    // 2. sensitive-host warning. Calls 1-3 keep the panel text on a state-changing call and say
    // nothing otherwise. From call 4 the volume note REPLACES it - not adds to it - and applies
    // to every call, screenshots included.
    // The extra one-line notices cost little next to the captures they discourage.
    if (onSensitive) {
      if (calls > CALLS_BEFORE_VOLUME_NOTE) {
        notice = `${calls} browser calls on ${host} this session, and page captures are the most ` +
          'expensive thing this tool family returns (tens of thousands of chars per screenshot). Finish this drive in a FOREGROUND subagent that returns the ' +
          'outcome instead of the captures, and where you do not need a coordinate use ' +
          'get_page_text or read_page - a few K chars for the same page. You are still inside an ' +
          'authenticated account panel: say what you will change, and do not open a ' +
          'credential-display field unless the user asked for that value.';
      } else if (mutating) {
        notice = `you are about to act inside an authenticated account panel (${host}): screenshot the ` +
          'current state BEFORE the first click, state in your reply exactly what you will change, ' +
          'and do not open a credential-display field unless the user asked for that value.';
      }
    }
  } catch (_) { /* fail open */ }

  if (notice) {
    try {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notice },
      }));
    } catch (_) {}
  }
  process.exit(0);
});
