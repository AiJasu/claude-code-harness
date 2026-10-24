'use strict';
// Fixtures for reply-lint.js. Run: node hooks/tests/reply-lint-fixtures.js
//
// Covers the glyph, reply-length, completion-claim, guard-block, plain-words and hand-back
// checks, plus pins for the deleted estimate arm and the absent need-hands arm.
// What is asserted is the exact string on hookSpecificOutput.additionalContext - the only channel
// that reaches the model (stderr on exit 0 is user-display only).
//
// The MENTION-ONLY cases are why this file exists. A reply that QUOTES a completion phrase as
// an example, or shows one inside a fenced block, must not trip the check.
//
// Glyphs are built from codepoints, never typed - the house rule forbids the literal characters
// and the PreToolUse guard blocks a Write that contains them.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'reply-lint.js');
const TRANSCRIPT = path.join(__dirname, '.tmp-reply-lint.jsonl');
const ARROW = String.fromCharCode(0x2192);
const CHECKMARK = String.fromCharCode(0x2705);
// The hook writes a heartbeat ledger into ~/.claude. Sandbox HOME so a test run cannot overwrite
// the live one.
const FAKEHOME = path.join(__dirname, '.fakehome-rl');
fs.mkdirSync(path.join(FAKEHOME, '.claude'), { recursive: true });

const U = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const A = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const A_TOOL = () => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } });
const U_RESULT = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });

function call(reply, prompt, rows, sessionId) {
  const recs = (rows || [U(prompt), A(reply)]).map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(TRANSCRIPT, recs);
  const input = { transcript_path: TRANSCRIPT };
  if (sessionId) input.session_id = sessionId; // omitted elsewhere in this file on purpose - see section 7
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(input),
    env: { ...process.env, HOME: FAKEHOME, USERPROFILE: FAKEHOME },
    encoding: 'utf8',
    timeout: 10000,
  });
  let ctx = null;
  try { ctx = JSON.parse(res.stdout || 'null'); } catch (_) {}
  return {
    status: res.status,
    note: (ctx && ctx.hookSpecificOutput && ctx.hookSpecificOutput.additionalContext) || '',
  };
}

const cases = [];
// want/deny are substrings of the note. Default prompt is short and keyword-free, so the
// length check is armed unless a case overrides it.
function T(name, reply, opts) { cases.push({ name, reply, prompt: 'is it done?', ...opts }); }
// Structural cases build the transcript records themselves via `rows`, to exercise the flush-lag
// scan rather than the linting rules.
const LONG = Array.from({ length: 20 }, (_, i) => 'Line ' + i + ' of a reply that breaks the cap.').join('\n');

// --- 1. icon glyphs (regression) --------------------------------------------------------------
T('icon-glyph fires on an arrow glyph in prose', 'Fixed the parser ' + ARROW + ' output is stable.',
  { want: ['icon-glyph:', 'icon glyph'] });
T('icon-glyph fires on an emoji', 'Deploy finished ' + CHECKMARK, { want: ['icon-glyph:'] });
T('icon-glyph clean on ASCII arrow', 'Fixed the parser -> output is stable.', { deny: ['icon-glyph:'] });

// --- 2. reply length (regression) -------------------------------------------------------------
T('reply-style fires on a long reply against a short prompt',
  Array.from({ length: 20 }, (_, i) => 'Line ' + i + ' of a long answer nobody asked for.').join('\n'),
  { want: ['reply-style:'] });
T('reply-style silent when the prompt asked for depth',
  Array.from({ length: 20 }, (_, i) => 'Line ' + i + ' of a long answer that was requested.').join('\n'),
  { prompt: 'give me the full breakdown in detail', deny: ['reply-style:'] });
T('reply-style silent on a slash command',
  Array.from({ length: 20 }, (_, i) => 'Line ' + i + ' of wrap output.').join('\n'),
  { prompt: '/wrap', deny: ['reply-style:'] });

// Threshold pins: each of these three was SILENT under a looser config (1200c/12L cap, 260-char
// short-prompt cutoff, wide DEPTH pattern) and must fire now, or a future edit reverts the
// tightening without a single fixture going red.
T('reply-style fires in the 10-line band the old 12-line cap allowed',
  Array.from({ length: 10 }, (_, i) => 'Line ' + i + ' of a mid-length answer.').join('\n'),
  { want: ['reply-style:', 'Need from you'] });
T('reply-style fires on a prompt whose only depth word was the old wide regex ("list")',
  Array.from({ length: 20 }, (_, i) => 'Line ' + i + ' of an answer nobody sized.').join('\n'),
  { prompt: 'can you list the open tasks in the queue?', want: ['reply-style:'] });
T('reply-style fires on a 300-char prompt the old 260 cutoff exempted',
  Array.from({ length: 20 }, (_, i) => 'Line ' + i + ' of an answer nobody sized.').join('\n'),
  { prompt: 'invented filler prompt for the length cutoff, '
    + 'lorem ipsum dolor sit amet, '.repeat(9) + 'consectetur adipiscing elit',
    want: ['reply-style:'] });

// DEPTH treats "break down" (spaced) like "breakdown" and accepts "list everything"/"list all".
// Both were SILENT misses under the narrower regex: the long reply fired though depth was asked.
T('reply-style silent when the prompt says "break down" (spaced)',
  Array.from({ length: 20 }, (_, i) => 'Line ' + i + ' of the breakdown that was asked for.').join('\n'),
  { prompt: 'Break down the test results again.', deny: ['reply-style:'] });
T('reply-style silent when the prompt says "list everything"',
  Array.from({ length: 20 }, (_, i) => 'Line ' + i + ' of the full list that was asked for.').join('\n'),
  { prompt: 'List everything the scan found.', deny: ['reply-style:'] });

// --- 3. the length cap needs a HUMAN-TYPED prompt ----------------------------------------------
// Scoring the nearest preceding user record would misfire on agentic turns, where that record is a
// tool_result with an empty text extract (prompt length 0, askedForDepth false). Each of the silent
// cases below is a long reply over both thresholds against a turn-starter that is NOT typed.
const U_NOTIF = () => ({ type: 'user', message: { role: 'user', content:
  '<task-notification>\n<task-id>task02</task-id>\n<output>Agent finished.</output>\n</task-notification>' } });
const U_SLASH = () => ({ type: 'user', isMeta: true, message: { role: 'user', content:
  '<command-message>best</command-message>\n<command-name>/best</command-name>' } });
const U_COMPACT = () => ({ type: 'user', isCompactSummary: true, message: { role: 'user', content:
  'This session is being continued from a previous conversation that ran out of context.' } });
// A real prompt with a system-reminder appended - the usual shape of a typed turn.
const REMINDER = '<system-reminder>' + 'Codebase and user instructions follow. '.repeat(14) + '</system-reminder>';
const U_REMINDED = (text) => ({ type: 'user', message: { role: 'user', content: text + '\n' + REMINDER } });

T('reply-style SILENT on a turn started by a tool result with no typed prompt in the tail',
  '', { rows: [A_TOOL(), U_RESULT(), A(LONG)], deny: ['reply-style:'] });
T('reply-style SILENT on a turn started by a background task-notification',
  '', { rows: [U_NOTIF(), A_TOOL(), U_RESULT(), A(LONG)], deny: ['reply-style:'] });
T('reply-style SILENT on a turn started by a slash command record',
  '', { rows: [U_SLASH(), A(LONG)], deny: ['reply-style:'] });
T('reply-style SILENT on the first reply after a compaction boundary',
  '', { rows: [U_COMPACT(), A(LONG)], deny: ['reply-style:'] });
// The other direction, and the proof the old code would have been SILENT on this input: raw
// content is over SHORT_PROMPT (400) only because of the appended reminder, so the un-stripped
// length exempted the reply. Stripping the wrapper restores "is it done?" as the real prompt.
T('reply-style FIRES on a short typed prompt whose length was inflated by a system-reminder',
  '', { rows: [U_REMINDED('is it done?'), A(LONG)], want: ['reply-style:'] });
T('reply-style still FIRES on a plain typed prompt behind a tool round-trip',
  '', { rows: [U('is it done?'), A_TOOL(), U_RESULT(), A(LONG)], want: ['reply-style:'] });
// The other arms never read the prompt: an autonomous turn is still linted for glyphs and
// completion claims. Without these, the typed-prompt gate could silence the whole hook and stay
// green.
T('icon-glyph still fires on an autonomous turn',
  '', { rows: [U_NOTIF(), A('Deploy finished ' + CHECKMARK)], want: ['icon-glyph:'] });
T('completion-claim still fires on an autonomous turn',
  '', { rows: [U_NOTIF(), A('Applied the patch set. All checks green.')], want: ['completion-claim:'] });

// --- 4. unsolicited estimate: arm DELETED under its own stopping rule --------------------------
// These pin the deletion. The first two are the shapes that ended it (a rate read as a forward
// estimate, and a test's pass criterion); the third is a shape the arm used to flag, silent now,
// so a revert that quietly restores the arm goes red here.
T('estimate arm gone: a per-week amount next to "about" is silent',
  'The plan allows at most 3 deploys a week, which is about one every other day.',
  { deny: ['unsolicited estimate'] });
T('estimate arm gone: a pass criterion in hours is silent',
  'The soak test needs 12 hours of traffic before it can pass.',
  { deny: ['unsolicited estimate'] });
T('estimate arm gone: a forward-looking figure is silent too',
  'That refactor will take 2 hours.',
  { deny: ['unsolicited estimate'] });

// MENTION vs USE. Double-quoted spans are blanked for the completion-claim content rule, and
// deliberately NOT for the glyph check or the length cap.
T('completion-claim silent when the claim phrase sits inside a quoted example',
  'The check exists to catch a reply that ends with "all checks green" and nothing more.',
  { deny: ['completion-claim:'] });
T('icon-glyph STILL fires on a glyph inside quotes (it renders either way)',
  'The commit message says "the parser ' + ARROW + ' the output".',
  { want: ['icon-glyph:'] });

// --- 5. flush lag: which reply does the scan select? ------------------------------------------
// A stale tail means the newest reply has not hit disk. Linting the previous one aims the note at
// a reply the user has moved past, so the hook must stay silent instead.
T('stale tail (user record after the last assistant) produces NO note',
  '', { rows: [U('first ask'), A(LONG), U('second ask')], deny: ['reply-style:'] });
T('flushed tail with interleaved tool records still lints the final text reply',
  '', { rows: [U('is it done?'), A_TOOL(), U_RESULT(), A(LONG)], want: ['reply-style:'] });
T('tool-use-only last assistant is skipped, and the tail reads as stale',
  '', { rows: [U('is it done?'), A(LONG), U('next ask'), A_TOOL(), U_RESULT()], deny: ['reply-style:'] });

// --- 6. completion claim -------------------------------------------------------------------
T('completion-claim fires on "all checks green" with no uncovered surface',
  'Applied the patch set, committed and pushed. All checks green.',
  { want: ['completion-claim:', 'left out'] });
T('completion-claim fires on "every rule kept"',
  'Merged the two lint configs, every rule kept.',
  { want: ['completion-claim:'] });
T('completion-claim fires on "the service is live"',
  'Shipped the new build. The service is live.',
  { want: ['completion-claim:'] });
T('completion-claim fires on "all 5 reports read"',
  'The batch finished. All 5 reports read and summarized.',
  { want: ['completion-claim:'] });
T('completion-claim fires on "fully verified"',
  'The migration is fully verified and the branch is merged.',
  { want: ['completion-claim:'] });

// Naming the limitation is what the rule asks for, so naming it must silence the check.
T('completion-claim silent when the uncovered surface is named',
  'All checks green: a syntax check on each hook and the full fixture suite. ' +
  'Not covered: the hook wiring in settings, which no test exercises.',
  { deny: ['completion-claim:'] });
T('completion-claim silent when a caveat is present',
  'All tests pass. Caveat: the suite never runs the Windows path branch.',
  { deny: ['completion-claim:'] });
T('completion-claim silent on a plain factual report with no scope word',
  'Committed abc1234 and pushed. The release commit has no upstream.',
  { deny: ['completion-claim:'] });

// MENTION-ONLY: quoting the phrase is not claiming it.
T('completion-claim silent when the phrase is inside a code span',
  'The rule bans replies like `all checks green` unless a check is named.',
  { deny: ['completion-claim:'] });
T('completion-claim silent when the phrase is inside a fenced block',
  'Example of a bad completion message:\n```\nAll checks green.\n```\nName the check instead.',
  { deny: ['completion-claim:'] });
T('completion-claim silent when the phrase is quoted from a transcript',
  '> All checks green.\n\nThat line is the unqualified-claim shape.',
  { deny: ['completion-claim:'] });

// --- 7. per-session repeat counter ---------------------------------------------------------------
// The same note repeating unchanged in one session is amplified noise. The fix is a
// session+category counter: silent on the 1st and 2nd occurrence, a repeat-count prefix from the
// 3rd on. All three cases below share one synthetic session id so they land in the same counter
// bucket; no case above this point sets a session id, so the shared FAKEHOME sandbox never
// accrues a count for the regression cases.
const REPEAT_SESSION = 'fixture-repeat-session';
// Idempotent across repeated runs of this file: without clearing prior state, a second run would
// start the count at 4/5/6 instead of 1/2/3 and case 3 below would falsely look like a pass.
try { fs.unlinkSync(path.join(FAKEHOME, '.claude', '.reply-lint-repeat.json')); } catch (_) {}
T('repeat counter silent on the 1st reply-style violation in a session',
  LONG, { sessionId: REPEAT_SESSION, want: ['reply-style:'], deny: ['time this session'] });
T('repeat counter silent on the 2nd reply-style violation in a session',
  LONG, { sessionId: REPEAT_SESSION, want: ['reply-style:'], deny: ['time this session'] });
T('repeat counter prefixes the 3rd reply-style violation in a session',
  LONG, { sessionId: REPEAT_SESSION, want: ['reply-style:', '3rd time this session'] });

// --- 8. a guard block this turn that the reply never mentioned --------------------------------
// The SUBAGENT and earlier-turn cases are the two exclusions that keep the firing population
// honest - subagent blocks (undisclosable in a main-loop reply) and blocks from an earlier turn (a
// disclosure two turns ago must not re-fire).
const BLOCK_LOG = path.join(FAKEHOME, '.claude', 'guard-blocks.jsonl');
function blockRow(session, o) {
  const row = {
    ts: new Date(Date.now() - ((o && o.agoMs) || 20000)).toISOString(),
    session_id: session,
    agent_id: (o && o.agentId) || null,
    tool: 'Bash',
    layer: (o && o.layer) || 'secret-exfil',
    target: null,
    cmd_sha256_8: 'deadbeef',
    reason: 'guard-hook: fixture row',
  };
  fs.appendFileSync(BLOCK_LOG, JSON.stringify(row) + '\n');
}
try { fs.unlinkSync(BLOCK_LOG); } catch (_) {}
blockRow('gb-silent');
blockRow('gb-named', { layer: 'secret-exfil' });
blockRow('gb-generic');
blockRow('gb-subagent', { agentId: 'agent-7' });
blockRow('gb-stale', { agoMs: 10 * 60 * 1000 });

T('guard-block fires when a block this turn goes unmentioned',
  'Re-ran the command without the second half and the counts look right.',
  { sessionId: 'gb-silent', want: ['guard-block:', 'secret-exfil', 'stop-and-report'] });
T('guard-block silent when the reply names the layer',
  'The secret-exfil layer stopped that command, so I left it as is and am reporting it here.',
  { sessionId: 'gb-named', deny: ['guard-block:'] });
T('guard-block silent when the reply says it was blocked without naming the layer',
  'That call was blocked, so the probe has not run yet.',
  { sessionId: 'gb-generic', deny: ['guard-block:'] });
T('guard-block silent for a SUBAGENT block - a main-loop reply cannot disclose it',
  'Re-ran the command without the second half and the counts look right.',
  { sessionId: 'gb-subagent', deny: ['guard-block:'] });
T('guard-block silent for a block from an earlier turn',
  'Re-ran the command without the second half and the counts look right.',
  { sessionId: 'gb-stale', deny: ['guard-block:'] });
T('guard-block silent for a session with no ledger rows at all',
  'Re-ran the command without the second half and the counts look right.',
  { sessionId: 'gb-none', deny: ['guard-block:'] });

// --- 9. plain-words arm: 3+ bare internal codes where plain words were due --------------------
T('plain-words fires on several unexplained codes',
  'Decided: T3 and T8 go first; T1/T4/T6 need a schema change; T2/T5 are yours, and T7 waits on T9.',
  { prompt: 'what next?', want: ['plain-words:', 'T3'] });
T('plain-words fires on coined labels too',
  'Picked arm A over arm C, per Decision 3.',
  { want: ['plain-words:'] });
T('plain-words silent on a product comparison (product names)',
  'The Acme Kettle K3 Plus is cheaper than the Globex T5 X, the Initech X2 sits between them, and the Vandelay EC2 is the priciest.',
  { deny: ['plain-words:'] });
T('plain-words silent on calendar quarters beside a year',
  'Sales fell in Q3 2024, recovered in Q1 2025, and the H1 2025 report calls Q2 2025 flat.',
  { deny: ['plain-words:'] });
T('plain-words silent on codes the user typed first',
  'T3 is the retry fix, T8 the log format, T1 the timeout.',
  { prompt: 'what are T3, T8 and T1?', deny: ['plain-words:'] });
T('plain-words silent on codes inside code spans',
  'Ran the `T3`, `T8` and `T1` fixtures; the changed files are listed below.',
  { deny: ['plain-words:'] });
T('plain-words silent at two codes',
  'T3 and T8 are next.',
  { deny: ['plain-words:'] });

// --- 10. hand-back arm: a Need item handed back a second time -----------------------------------
// A Need-from-you bullet that also sits (word overlap 0.6+) in the session's previous final reply:
// the SECOND hand-back. A bar at the third ask (a match in each of the last two replies) would be
// SILENT on every r2 `want` case below, so they pin the second-ask bar. The deny cases pin what the
// arm must NOT do (fire on a 1st ask, fire on a reworded item, count one reply twice, read a fenced
// example). All bullets are synthetic. Overlap values were computed, not guessed: NEAR is 0.77
// against ITEM (a bar of 0.8 would miss it), HALF is 0.47 (a bar of 0.4 would fire).
try { fs.unlinkSync(path.join(FAKEHOME, '.claude', '.reply-lint-need.json')); } catch (_) {}
const ITEM = 'Restart the ingest worker on the staging box and tell me whether the queue drains';
const NEAR = 'Restart the ingest worker on the staging box and tell me whether the queue has drained';
const HALF = 'Restart the ingest worker on the staging box and confirm the backlog is cleared afterwards';
const OTHER = 'Rotate the signing key for the mirror and paste the new fingerprint into the tracker';
// Every built reply opens with a different sentence: the hook counts a byte-identical reply once
// (flush lag can read one twice), so three replies with the same text would read as one.
let seq = 0;
const OPEN = () => 'Fixed it, round ' + (++seq) + ' of the parser.';
const NEED = (...bullets) => OPEN() + '\n\nNeed from you:\n' + bullets.map((b) => '- ' + b).join('\n');
const NO_NEED = () => OPEN();
const HB = 'second hand-back';

T('need-repeat silent on the 1st appearance of an item', NEED(ITEM),
  { sessionId: 'nr-basic', deny: ['need-repeat:'] });
T('need-repeat FIRES on the 2nd appearance of the same item', NEED(ITEM),
  { sessionId: 'nr-basic', want: ['need-repeat:', HB] });
T('need-repeat still fires on the 3rd appearance', NEED(ITEM),
  { sessionId: 'nr-basic', want: ['need-repeat:', HB] });
T('need-repeat still fires on the 4th appearance', NEED(ITEM),
  { sessionId: 'nr-basic', want: ['need-repeat:', HB] });

T('need-repeat pin: a bullet at 0.47 overlap is silent (r1)', NEED(ITEM), { sessionId: 'nr-half', deny: ['need-repeat:'] });
T('need-repeat pin: a bullet at 0.47 overlap is silent (r2)', NEED(HALF), { sessionId: 'nr-half', deny: ['need-repeat:'] });
T('need-repeat pin: a bullet at 0.77 overlap fires (r1)', NEED(ITEM), { sessionId: 'nr-near', deny: ['need-repeat:'] });
T('need-repeat pin: a bullet at 0.77 overlap fires (r2)', NEED(NEAR), { sessionId: 'nr-near', want: ['need-repeat:', HB] });

T('need-repeat chain breaks on a reply with no Need section (r1)', NEED(ITEM), { sessionId: 'nr-gap', deny: ['need-repeat:'] });
T('need-repeat chain breaks on a reply with no Need section (r2, none)', NO_NEED(), { sessionId: 'nr-gap', deny: ['need-repeat:'] });
T('need-repeat chain breaks on a reply with no Need section (r3)', NEED(ITEM), { sessionId: 'nr-gap', deny: ['need-repeat:'] });

// Flush lag can hand the hook the SAME reply twice. Counted twice it would make the 1st real
// appearance look like the 2nd hand-back: 'r1 again' pins the sig guard.
const READ_TWICE = NEED(ITEM);
T('need-repeat counts a reply read twice once (r1)', READ_TWICE, { sessionId: 'nr-twice', deny: ['need-repeat:'] });
T('need-repeat counts a reply read twice once (r1 again)', READ_TWICE, { sessionId: 'nr-twice', deny: ['need-repeat:'] });
T('need-repeat counts a reply read twice once (r2)', NEED(ITEM, OTHER), { sessionId: 'nr-twice', want: ['need-repeat:', HB] });

// MENTION-ONLY: a Need block shown inside a fenced example is not the reply asking.
T('need-repeat silent when the Need block sits inside a fenced example (r1)', NEED(ITEM), { sessionId: 'nr-fence', deny: ['need-repeat:'] });
T('need-repeat silent when the Need block sits inside a fenced example (r2)',
  'Example of the shape to avoid:\n```\n' + NEED(ITEM) + '\n```\nName the decision instead.',
  { sessionId: 'nr-fence', deny: ['need-repeat:'] });

T('need-repeat silent on a bullet too thin to identify (r1)', NEED('Your call on this.'), { sessionId: 'nr-thin', deny: ['need-repeat:'] });
T('need-repeat silent on a bullet too thin to identify (r2)', NEED('Your call on this.'), { sessionId: 'nr-thin', deny: ['need-repeat:'] });

// Any bullet may carry the match, in any position, alongside others.
T('need-repeat with two items: r1 has ITEM and OTHER', NEED(OTHER, ITEM), { sessionId: 'nr-two', deny: ['need-repeat:'] });
T('need-repeat with two items: r2 carries ITEM beside a new item and fires', NEED('Approve the new retention window for the audit export before Friday', ITEM), { sessionId: 'nr-two', want: ['need-repeat:', HB] });
T('need-repeat with two items: r3 has only new items', NEED('Pick a name for the release branch and say go'), { sessionId: 'nr-two', deny: ['need-repeat:'] });

// Spelling variants of the section: bold label with the colon inside, numbered items, a wrapped item.
const NEED_BOLD = (b) => OPEN() + '\n\n**Need from you:**\n1. ' + b.slice(0, 44) + '\n   ' + b.slice(44);
T('need-repeat bold label + numbered + wrapped item (r1)', NEED_BOLD(ITEM), { sessionId: 'nr-form', deny: ['need-repeat:'] });
T('need-repeat bold label + numbered + wrapped item (r2)', NEED_BOLD(ITEM), { sessionId: 'nr-form', want: ['need-repeat:', HB] });

// State is keyed by session: the same item once in each of three sessions is three 1st appearances.
T('need-repeat state is per session (a)', NEED(ITEM), { sessionId: 'nr-s-a', deny: ['need-repeat:'] });
T('need-repeat state is per session (b)', NEED(ITEM), { sessionId: 'nr-s-b', deny: ['need-repeat:'] });
T('need-repeat state is per session (c)', NEED(ITEM), { sessionId: 'nr-s-c', deny: ['need-repeat:'] });
// No session id on the input: nothing to key the count on, so it stays silent.
T('need-repeat silent without a session id (r1)', NEED(ITEM), { deny: ['need-repeat:'] });
T('need-repeat silent without a session id (r2)', NEED(ITEM), { deny: ['need-repeat:'] });

// --- 11. no need-hands arm in this copy ---------------------------------------------------------
// Desktop clicks and signed-in browser work are always-stop in this copy's CLAUDE.md, so a Need
// item handing them to the user is correct and no note may push Claude to do them itself. These
// bullets fired the removed arm.
T('handing back desktop work stays silent',
  NEED('Close the Settings app so the installer can finish.'),
  { deny: ['need-hands:', 'drive-screen'] });
T('handing back signed-in browser work stays silent',
  NEED('On the account settings page, tick the two privacy switches and save.'),
  { deny: ['need-hands:', 'drive-screen'] });

let pass = 0, fail = 0;
const lines = [];
for (const c of cases) {
  const r = call(c.reply, c.prompt, c.rows, c.sessionId);
  const problems = [];
  if (r.status !== 0) problems.push('exit ' + r.status);
  for (const w of c.want || []) if (!r.note.includes(w)) problems.push('missing "' + w + '"');
  for (const d of c.deny || []) if (r.note.includes(d)) problems.push('unexpected "' + d + '"');
  if (problems.length) { fail++; lines.push('FAIL  ' + c.name + '  [' + problems.join('; ') + ']  note="' + r.note + '"'); }
  else { pass++; lines.push('PASS  ' + c.name + (r.note ? '  note="' + r.note.slice(0, 60) + '"' : '')); }
}

// The heartbeat that makes a silent run falsifiable: a silent run on an empty ledger and a
// silent run on no ledger at all look identical from the outside unless the beat file exists.
{
  const beatFile = path.join(FAKEHOME, '.claude', '.reply-lint-seen.json');
  const ok = fs.existsSync(beatFile);
  if (ok) { pass++; lines.push('PASS  guard-block the heartbeat ledger is written even on silent runs'); }
  else { fail++; lines.push('FAIL  guard-block no heartbeat ledger at ' + beatFile); }
}

try { fs.unlinkSync(TRANSCRIPT); } catch (_) {}
try { fs.unlinkSync(BLOCK_LOG); } catch (_) {}
console.log(lines.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed of ' + (pass + fail) + ' cases');
process.exitCode = fail > 0 ? 1 : 0;
