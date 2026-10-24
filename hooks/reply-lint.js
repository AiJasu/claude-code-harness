// Stop hook: lint the reply that was just sent against the house rules that prose alone
// has failed to hold - icon glyphs, the reply-length cap, an undisclosed guard block,
// completion claims whose scope outruns the checks behind them, replies that name things by bare
// internal codes (plain-words arm), and a Need-from-you item handed back a second time (hand-back
// arm). The unsolicited-estimate arm was deleted under its own stopping rule (tombstone below). The
// need-hands arm (screen work handed back as a Need item) is not in this copy: desktop clicks and
// signed-in browser work are always-stop here, so handing them back is correct.
//
// Delivery: one hookSpecificOutput.additionalContext line on STDOUT. stderr on exit 0 is
// user-display only and never reaches the model.
// A Stop hook fires after the reply is sent, so the note lands at the START of the next turn -
// it corrects the next reply, it cannot un-send this one. Warn only; never blocks; exit 0 always.
//
// Scope: text blocks of the LAST assistant message, with fenced and inline code stripped. The
// length cap additionally needs a HUMAN-TYPED triggering message that was short, keyword-free
// and not a slash command - a long deliverable the user asked for is not a violation, and neither
// is a turn no one prompted.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Heartbeat, same reason as wf-concurrency.js: this hook is silent on a clean reply, so "it ran
// and found nothing" is indistinguishable from "it never ran". It also records WHICH reply the
// reverse scan selected, so a note can be compared against the reply it was meant for.
const SEEN = path.join(os.homedir(), '.claude', '.reply-lint-seen.json');
const TAIL_BYTES = 512 * 1024;
// Sized so most replies are in scope and a minority fire. A wider cap plus a wide DEPTH pattern
// exempted too many replies on words like "list"/"plan"/"write"/"review".
const MAX_CHARS = 900;
const MAX_LINES = 9;
const SHORT_PROMPT = 400;
const DEPTH = /in detail|detailed|break ?down|explain|walk me through|draft|write (?:me )?(?:a|an|the)|spec\b|guide\b|audit|full (?:report|list|break ?down|rundown)|list (?:everything|all)\b/i;
const GLYPH = /[\u2190-\u21FF\u2300-\u23FF\u25A0-\u27BF\u2B00-\u2BFF\uFE0F]|[\uD83C-\uDBFF][\uDC00-\uDFFF]/g;
// UNSOLICITED-ESTIMATE ARM: DELETED under its own stopping rule ("if another false positive
// appears here, delete the check rather than patch it"). Even after carve-outs and an inversion to
// a forward-cue design it kept flagging rates and pass criteria, because a duration word cannot
// tell a rate or a requirement from a guess about work. Do not re-add a lexical version; the
// CLAUDE.md rule is unenforced.

// Completion claims: a reply that closes with a claim broader than the evidence behind it ("all
// checks green", "every file fixed", "the service is live"). The prose rule lives in CLAUDE.md
// (Response length); the mechanical half is saying what the checks left untested. A lexical
// "did you name a check" test is useless - wrong replies name files and counts too. So the trigger
// is an ABSOLUTE completion phrase with no limitation clause anywhere in the reply. Code spans and
// fenced blocks are already stripped, so a reply quoting one of these phrases as an example does
// not trip it.
const CLAIM = new RegExp([
  'all (?:checks?|tests?|of them|\\d+)[^.\\n]{0,32}(?:green|pass(?:ed|ing)?|done|read|fixed|applied|verified|clean)',
  'every (?:rule|file|item|one|check|test|finding|instance)[^.\\n]{0,32}(?:kept|done|fixed|applied|covered|passed|verified)',
  'everything (?:works|passes|passed|is (?:working|green|done|fixed))',
  'fully (?:verified|working|applied|covered|fixed|migrated|clean)',
  'all green',
  'no (?:issues|errors|failures|problems)[^.\\n]{0,24}(?:remain|left|found)',
  '(?:is|now) live\\b',
  'it (?:all )?works\\b',
  'confirmed (?:working|live|green|fixed)',
].join('|'), 'i');
const UNCOVERED = /\b(?:un(?:tested|verified|checked|covered)|not (?:cover|check|test|verif|exercis|run|read)|did ?n[o']t|does ?n[o']t|was ?n[o']t|except\b|apart from|other than|left out|still (?:open|unpushed|missing|fail|broken|pending)|no check|cannot (?:confirm|verify|prove)|caveat|assum(?:e|ed|ption)|unknown|skipped)/i;

// PLAIN-WORDS ARM. The terse output style says a thing is named by what it is, never by an
// internal ID, unless its meaning rides along. Counts distinct bare codes ([A-Z]{1,2}+1-2 digits,
// "patch NN", "arm X", "Decision N") in the code-stripped reply; fires at 3. Skips a code the typed
// prompt contains (the user used it first), one right after a Capitalized word (a product name:
// "Kettle K3"), and Q1-Q4 / H1-H2 beside a year. Does not check whether a meaning rides along -
// 3 codes is the bar.
// STOPPING RULE: the next false positive that needs a new carve-out - delete the arm, do not
// patch it.
const ID_CODE = /\b([A-Z]{1,2}\d{1,2}[a-z]?)\b/g;
const ID_LABEL = /\b(patch(?:es)? \d{1,2}|arm [A-D]|Decision \d)\b/gi;
const NOT_A_NAME = /^(Decided|Pending|Need|Build|Run|Ship|Fix|Close|Open|See|Item|Finding|Patch)$/;
const PLAIN_MIN = 3;

function bareIds(body, prompt) {
  const ids = new Set();
  let m;
  ID_CODE.lastIndex = 0;
  while ((m = ID_CODE.exec(body)) !== null) {
    const before = body.slice(Math.max(0, m.index - 40), m.index);
    const prev = (before.match(/([A-Za-z][\w-]*)\s+$/) || [])[1] || '';
    if (/^[A-Z][a-z]/.test(prev) && !NOT_A_NAME.test(prev)) continue;
    const after = body.slice(m.index + m[1].length, m.index + m[1].length + 6);
    if (/^(Q[1-4]|H[12])$/.test(m[1]) && (/\d{4}\s*$/.test(before) || /^\s+\d{4}\b/.test(after))) continue;
    if (prompt.includes(m[1])) continue;
    ids.add(m[1]);
  }
  const lower = prompt.toLowerCase();
  for (const x of body.match(ID_LABEL) || []) if (!lower.includes(x.toLowerCase())) ids.add(x.toLowerCase());
  return ids;
}

function readTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

function textOf(msg) {
  const c = msg && msg.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

function strip(t) {
  return String(t).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ').replace(/^\s*>.*$/gm, ' ');
}

// The reply-length arm must not score every turn against the nearest preceding user record: in an
// agentic turn that record is a tool_result, textOf() keeps only `text` blocks, so the extract is
// empty, prompt length is 0, askedForDepth is false - and the arm would fire on autonomous turns
// BY CONSTRUCTION.
//
// So it requires POSITIVE evidence that a human typed something, and an unrecognized turn shape
// goes SILENT instead of wrong. Tool results, task-notifications, slash commands and
// local-command output are not typed prompts. Every wrapper tag is closed, so the paired strip
// below is sound. The other arms never read the prompt and are untouched.
const WRAPPER = /<(task-notification|system-reminder|local-command-caveat|local-command-stdout|command-message|command-name|command-args|bash-input|bash-stdout|bash-stderr)>[\s\S]*?<\/\1>/g;
const INTERRUPT = /^\[Request interrupted by user[^\]]*\]$/;

function isToolResult(rec) {
  if (!rec) return false;
  if (rec.toolUseResult !== undefined) return true;
  const c = rec.message && rec.message.content;
  return Array.isArray(c) && c.some((b) => b && b.type === 'tool_result');
}

// 'typed' (a real prompt) | 'tool' | 'meta' | 'wrapped' | 'none'. Only 'typed' arms the length cap.
function classifyUser(rec) {
  if (isToolResult(rec)) return 'tool';
  if (rec.isMeta || rec.isCompactSummary) return 'meta';
  const raw = textOf(rec.message).trim();
  if (!raw) return 'none';
  const bare = raw.replace(WRAPPER, ' ').trim();
  if (!bare || INTERRUPT.test(bare)) return 'wrapped';
  return 'typed';
}

// A figure QUOTED as an example ("Expect 3 days for the migration", written while describing this
// very check) is not the reply volunteering that estimate. Backticked and fenced text is already
// stripped; plain double quotes were not.
//
// Applied to the completion-claim content rule only (the estimate rule it was written for is
// deleted). A glyph inside quotes still renders as a glyph, and
// quoted text still costs the reader lines, so the glyph check and the length cap deliberately
// keep reading the full body.
function unquote(t) { return t.replace(/"[^"\n]{0,400}"/g, ' '); }

// --- a guard block answered by a reshaped retry --------------------------------------------
//
// guard-hook.js's blockLog() writes ~/.claude/guard-blocks.jsonl. CLAUDE.md says a block is
// stop-and-report, and prose alone does not hold: a reply that says nothing about a block just
// happened is the failure this arm catches.
//
// SUBAGENT blocks are excluded (agent_id set): a main-loop reply cannot disclose them. The window
// is this turn, not this session: a block disclosed two turns ago must not re-fire.
const BLOCK_LEDGER = path.join(os.homedir(), '.claude', 'guard-blocks.jsonl');
const BLOCK_WINDOW_MS = 5 * 60 * 1000;
const BLOCK_TAIL = 64 * 1024;
const DISCLOSED = /\bguard(?:[- ]hook)?\b|\bblocked\b|\bthe block\b/i;

function undisclosedBlocks(session, body) {
  if (!session) return [];
  let raw;
  try {
    const fd = fs.openSync(BLOCK_LEDGER, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, BLOCK_TAIL);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
  } catch (_) { return []; }
  const now = Date.now();
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim() || line.indexOf(session) === -1) continue;
    let b;
    try { b = JSON.parse(line); } catch (_) { continue; }   // a sliced first line, skip it
    if (b.session_id !== session || b.agent_id) continue;
    const ts = Date.parse(b.ts);
    if (!ts || now - ts > BLOCK_WINDOW_MS || ts > now) continue;
    const layer = String(b.layer || 'guard');
    const named = new RegExp(layer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[- ]'), 'i');
    if (named.test(body) || DISCLOSED.test(body)) continue;
    out.push({ layer, tool: b.tool, agoSec: Math.round((now - ts) / 1000) });
  }
  return out;
}

function beat(session, body, notes, waited, stale, promptKind) {
  try {
    fs.writeFileSync(SEEN, JSON.stringify({
      _lastFired: new Date().toISOString(),
      _lastSession: session || null,
      chars: body.length,
      lines: body.split('\n').filter((l) => l.trim()).length,
      head: body.replace(/\s+/g, ' ').slice(0, 70),
      notes: notes.map((n) => n.split(':')[0]),
      // How many polls the flush took, and whether it never arrived. `waited` is the measurement
      // that says whether POLL_TRIES is sized right: if it creeps toward the cap, raise it; if it
      // is 0 every time, the wait can go.
      waited,
      stale,
      // Which record started the turn. Anything but 'typed' means the length cap was SKIPPED, not
      // passed - without this the ledger cannot tell "scored and clean" from "never eligible".
      promptKind: promptKind || 'none',
    }, null, 2));
  } catch (_) { /* never let the ledger break the hook */ }
}

// Per-session repeat counter: a correctly-delivered one-off advisory has no memory of its own
// repetition, so the same note can fire again and again unchanged. Same state-file shape as
// poll-guard's own "Nth read in a window" counter: session-keyed, GC'd on an idle TTL, atomic
// tmp+rename write.
//
// Deliberately keyed per CATEGORY, not per exact note text - two reply-style notes never repeat
// the same char/line count, so a text-equality counter would never reach the threshold.
const REPEAT_STATE = path.join(os.homedir(), '.claude', '.reply-lint-repeat.json');
const REPEAT_TTL_MS = 24 * 60 * 60 * 1000; // idle sessions age out, same TTL class as poll-guard
const REPEAT_THRESHOLD = 3;                // prefix starts on the 3rd occurrence, not the 1st

function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return n + 'th';
  const rem10 = n % 10;
  return n + (rem10 === 1 ? 'st' : rem10 === 2 ? 'nd' : rem10 === 3 ? 'rd' : 'th');
}

// Bumps the session+category count and returns TEXT, prefixed once the count reaches
// REPEAT_THRESHOLD. Never throws: a broken counter must not cost the hook its actual note.
function withRepeat(session, category, text) {
  if (!session) return text; // no session id on this input: nothing to key the count on
  let all = {};
  try { all = JSON.parse(fs.readFileSync(REPEAT_STATE, 'utf8')) || {}; } catch (_) { all = {}; }
  try {
    const now = Date.now();
    for (const sid of Object.keys(all)) {
      const s = all[sid];
      if (!s || typeof s._last !== 'number' || now - s._last > REPEAT_TTL_MS) delete all[sid];
    }
    const sess = (all[session] && typeof all[session] === 'object') ? all[session] : {};
    sess._last = now;
    sess[category] = (typeof sess[category] === 'number' ? sess[category] : 0) + 1;
    all[session] = sess;
    const tmp = REPEAT_STATE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, REPEAT_STATE);
    const n = sess[category];
    return n >= REPEAT_THRESHOLD ? `(${ordinal(n)} time this session) ${text}` : text;
  } catch (_) { return text; }
}

// HAND-BACK ARM. CLAUDE.md (Autonomy): a question handed BACK a second time is answered - decided,
// with the sub-decision that needs the user named. Prose alone did not hold, and a note on the
// third ask landed too late to stop it, so this fires on the SECOND hand-back: a Need bullet with
// word overlap (Jaccard) of 0.6 or more with a Need bullet in this session's previous final reply.
// A question whose wording drifts between asks is missed on purpose: a miss is silence, not a
// wrong note.
// State: ~/.claude/.reply-lint-need.json - session keyed, the previous reply's Need-bullet word
// lists only, 24h idle expiry, atomic write. A reply read twice (flush lag) counts once. Read-only
// to every other hook; reply-lint stays its one writer.
// STOPPING RULE: the first live false positive deletes this arm; do not add a carve-out.
const NEED_STATE = path.join(os.homedir(), '.claude', '.reply-lint-need.json');
const NEED_TTL_MS = 24 * 60 * 60 * 1000;
const NEED_HEAD = /(?:^|\n)[ \t]*(?:\*\*)?Need from you(?:\*\*)?[ \t]*:/i;
const NEED_BULLET = /^[ \t]*(?:[-*]|\d+[.)])[ \t]+/;
const NEED_JACCARD = 0.6;
const NEED_MIN_WORDS = 4;    // a bullet shorter than this is too thin to call "the same item"
const NEED_MAX_WORDS = 40;   // stored per bullet; both sides of a comparison use the same cap

// The bullets of the reply's "Need from you" section: text after the label, then each list item
// until the first line that is neither a bullet, blank, nor an indented continuation.
function needBullets(reply) {
  const text = String(reply).replace(/```[\s\S]*?```/g, ' ');
  const head = NEED_HEAD.exec(text);
  if (!head) return [];
  const rest = text.slice(head.index + head[0].length).split('\n');
  const items = [];
  const first = rest[0].replace(/\*\*/g, ' ').trim();
  if (first) items.push(first);
  for (let i = 1; i < rest.length; i++) {
    const line = rest[i];
    if (!line.trim()) continue;
    if (NEED_BULLET.test(line)) { items.push(line.replace(NEED_BULLET, '').trim()); continue; }
    if (/^[ \t]+\S/.test(line) && items.length) { items[items.length - 1] += ' ' + line.trim(); continue; }
    break;
  }
  return items
    .map((t) => ({ text: t.replace(/\*\*/g, ''), words: [...new Set(t.toLowerCase().match(/[a-z0-9]{3,}/g) || [])].slice(0, NEED_MAX_WORDS) }))
    .filter((b) => b.words.length >= NEED_MIN_WORDS)
    .slice(0, 6);
}

function jaccard(a, b) {
  const inB = new Set(b);
  let both = 0;
  for (const w of a) if (inB.has(w)) both++;
  return both / (a.length + b.length - both || 1);
}

// Records this reply's Need bullets for the session and returns the text of a bullet that also sits
// in the previous final reply, or null. Never throws: a broken ledger costs the note, not the hook.
function secondHandBack(session, reply) {
  if (!session) return null;
  try {
    const cur = needBullets(reply);
    let all = {};
    try { all = JSON.parse(fs.readFileSync(NEED_STATE, 'utf8')) || {}; } catch (_) { all = {}; }
    const now = Date.now();
    for (const sid of Object.keys(all)) {
      const s = all[sid];
      if (!s || typeof s._last !== 'number' || now - s._last > NEED_TTL_MS) delete all[sid];
    }
    if (!cur.length && !all[session]) return null;   // nothing to remember, nothing to compare
    const sess = (all[session] && Array.isArray(all[session].prev)) ? all[session] : { prev: [] };
    const sig = crypto.createHash('sha1').update(reply).digest('hex').slice(0, 16);
    if (sess.sig === sig) return null;               // the same reply read a second time
    let hit = null;
    if (sess.prev.length >= 1) {
      const seenIn = (b, prevReply) => prevReply.some((w) => jaccard(b.words, w) >= NEED_JACCARD);
      for (const b of cur) {
        if (seenIn(b, sess.prev[0])) { hit = b.text; break; }
      }
    }
    sess.prev = [cur.map((b) => b.words)];
    sess.sig = sig;
    sess._last = now;
    all[session] = sess;
    const tmp = NEED_STATE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, NEED_STATE);
    return hit;
  } catch (_) { return null; }
}

// The JSONL line for the reply that just ended the turn is not always on disk when this hook runs.
// Left alone, every note is one turn late, names the wrong reply, and the final reply of a session
// is never linted at all - which is precisely the completion report the completion-claim check
// exists for.
//
// A stale tail is detectable without guessing: on a flushed transcript nothing follows the last
// assistant record, so a user record sitting AFTER it means the reply is still in flight. Poll for
// it, and if it never lands, lint nothing rather than lint the wrong reply.
const POLL_MS = 150;
const POLL_TRIES = 20;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function selectReply(tp) {
  const lines = readTail(tp).split('\n');
  let reply = '', prompt = '', at = -1;
  // 'none' also covers the scan running off the start of the 512KB tail without reaching a
  // turn-starter, which a single turn of fat tool results can do. Unknown shape = silent.
  let promptKind = 'none';
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let rec;
    try { rec = JSON.parse(lines[i]); } catch (_) { continue; }
    const role = rec.message && rec.message.role;
    if (!reply && role === 'assistant') {
      const t = textOf(rec.message);
      if (!t.trim()) continue;   // tool-use-only turn: keep scanning back for the text reply
      reply = t;
      at = i;
    } else if (reply && role === 'user') {
      // Scan PAST this turn's own tool results to the record that STARTED the turn. Stopping at
      // the nearest user record is what made every agentic turn look like an empty prompt.
      if (isToolResult(rec)) continue;
      promptKind = classifyUser(rec);
      // Strip the reminders appended to a real prompt before measuring it: unstripped, a routine
      // ask plus one system-reminder blows past SHORT_PROMPT and silently exempts itself.
      if (promptKind === 'typed') prompt = textOf(rec.message).replace(WRAPPER, ' ');
      break;
    }
  }
  let stale = false;
  if (at >= 0) {
    for (let i = at + 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      let rec;
      try { rec = JSON.parse(lines[i]); } catch (_) { continue; }
      if (rec.message && rec.message.role === 'user') { stale = true; break; }
    }
  }
  return { reply, prompt, promptKind, stale };
}

const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', async () => {
  const notes = [];
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!input.transcript_path || !fs.existsSync(input.transcript_path)) process.exit(0);

    let waited = 0;
    let sel = selectReply(input.transcript_path);
    while (sel.stale && waited < POLL_TRIES) {
      await delay(POLL_MS);
      waited++;
      sel = selectReply(input.transcript_path);
    }
    if (!sel.reply.trim()) process.exit(0);

    const body = strip(sel.reply);
    const prompt = sel.prompt;
    if (sel.stale) {
      // The newest reply never landed. Linting the previous one would aim the note at a reply the
      // user has already moved past, so say nothing and record why.
      beat(input.session_id, body, [], waited, true, sel.promptKind);
      process.exit(0);
    }

    // 1. icon glyphs
    const gl = body.match(GLYPH);
    if (gl) {
      const kinds = [...new Set(gl)].map((g) => 'U+' + g.codePointAt(0).toString(16).toUpperCase()).slice(0, 4);
      notes.push(withRepeat(input.session_id, 'icon-glyph',
        `icon-glyph: last reply used ${gl.length} icon glyph(s) (${kinds.join(' ')}) - write "->" or a word.`));
    }

    // 2. reply length, but only against a short, keyword-free, non-slash prompt
    const p = prompt.trim();
    const askedForDepth = p.length > SHORT_PROMPT || DEPTH.test(p) || p.startsWith('/');
    const nLines = body.split('\n').filter((l) => l.trim()).length;
    if (sel.promptKind === 'typed' && !askedForDepth && (body.length > MAX_CHARS || nLines > MAX_LINES)) {
      notes.push(withRepeat(input.session_id, 'reply-style',
        `reply-style: last reply ${body.length} chars / ${nLines} lines against a short prompt - default shape is the answer in 1-4 lines, then only a non-empty "Pending:" and "Need from you:".`));
    }

    // Quoted examples are mentions, not claims (see unquote above).
    const cited = unquote(body);

    // 3. a guard block this turn that the reply never mentioned
    for (const b of undisclosedBlocks(input.session_id, body)) {
      notes.push(withRepeat(input.session_id, 'guard-block',
        `guard-block: the ${b.layer} layer blocked a ${b.tool || 'tool'} call ${b.agoSec}s ago and ` +
        'this reply does not mention it. CLAUDE.md: a block is stop-and-report - name the layer ' +
        'in your reply before retrying, and never reshape the command to miss the pattern. If it ' +
        'was a false positive, say so and fix the layer.'));
      break;   // one note however many blocks; the ledger holds the rest
    }

    // 4. completion claim wider than the checks behind it
    const claim = cited.match(CLAIM);
    if (claim && !UNCOVERED.test(body)) {
      notes.push(withRepeat(input.session_id, 'completion-claim',
        `completion-claim: last reply claimed "${claim[0].trim().slice(0, 48)}" with no surface named as unchecked - ` +
        `back a scope word with the check behind it and say what that check left out, or drop the scope word.`));
    }

    // 5. bare internal codes where plain words were due (plain-words arm)
    const ids = bareIds(body, prompt);
    if (ids.size >= PLAIN_MIN) {
      notes.push(withRepeat(input.session_id, 'plain-words',
        `plain-words: last reply used ${ids.size} internal codes (${[...ids].slice(0, 5).join(', ')}) - ` +
        'name each thing by what it is; a code appears only with its meaning beside it.'));
    }

    // 6. a Need-from-you item handed back a second time (hand-back arm, header above)
    const again = secondHandBack(input.session_id, sel.reply);
    if (again) {
      notes.push(withRepeat(input.session_id, 'need-repeat',
        `need-repeat: second hand-back of the same Need from you item ("${again.slice(0, 40).trim()}") - ` +
        'the next reply decides it and says which way; if only the user can answer it (a fact, their ' +
        'login, an always-stop action), keep it to one line that restates your recommendation; do not ask it a third time.'));
    }
    beat(input.session_id, body, notes, waited, false, sel.promptKind);
  } catch (_) { /* fail open */ }

  if (notes.length) {
    try {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'Stop', additionalContext: notes.join(' ') },
      }));
    } catch (_) {}
  }
  process.exit(0);
});
