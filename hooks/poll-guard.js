#!/usr/bin/env node
// poll-guard.js - PreToolUse WARN-ONLY nudge against polling an artifact that announces its
// own completion. Matcher in settings.json: Bash|PowerShell|Read.
//
// Re-reading a running Workflow's journal.jsonl, tailing a background build log or reading task
// .output files over and over costs a full-context turn each time and returns nothing. The rule
// is already prose in gotchas.md ("Claude Code harness": never wait with a foreground sleep, arm
// a Monitor on the TERMINAL condition, a completion notification re-invokes the turn anyway).
// Prose alone did not hold; this is the in-the-moment nudge.
//
// NEVER blocks. The only channel that reaches the model is hookSpecificOutput.additionalContext
// on stdout with exit 0 (stderr and systemMessage are user-display only) - same contract as
// guard-hook.js's note()/finish(). Any internal error fails OPEN: exit 0, no output.
//
// Detection is deliberately narrow, in two steps. STEP 1 finds the poll TARGETS of a call:
//   1. any path token containing journal.jsonl              (a running Workflow's log)
//   2. any path token matching  /tasks/<something>.output    (a task/Workflow result file)
//   3. a tail|head|cat|type|rg|grep|sed -n|Get-Content invocation whose argument ends in
//      .log .txt .out .err .jsonl
// (3) needs a reader VERB, so it can only come from a command string; a Read of a .txt is not
// flagged, which is the deliberate hole - a lone Read of a build log reads like ordinary work
// and .txt is far too common to count on the Read tool.
//
// STEP 2 decides whether to SPEAK. Counting: the 3rd reference or later to the SAME target within
// 10 minutes, then every subsequent one; nothing resets it, the 15-minute retention window
// expires entries. But the note is only emitted when the session transcript (transcript_path in
// the payload) holds POSITIVE evidence that the target is the output of a task backgrounded in
// this session: a run_in_background tool_use whose command names the file, or a tool_result
// "Output is being written to ..." / "launched in background" naming it (that is also how an
// auto-backgrounded timeout and a Workflow announce themselves). No transcript, an unreadable or
// over-64MB one, or no such record: silent. Without this gate the count also fired on re-reads
// after synchronous runs, a log the model had just written, or a filter pass over a finished file.
// Fixtures: node hooks/tests/poll-guard-fixtures.js
//
// STOPPING RULE (the inversion above is this rule's own "invert" step): the expected false
// positive now is a third read of a backgrounded task's output AFTER its completion notice
// (re-reading a finished result is not polling). The next false positive: delete this hook and its
// settings.json entry. No carve-outs for "finished" tasks, a third patch to a pattern rule is the
// signal to delete it.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
// Home-dir relative so the same script works under any account and so the fixtures can sandbox
// it with HOME/USERPROFILE.
const STATE = path.join(HOME, '.claude', 'hooks', '.poll-guard-state.json');

const KEEP_MS = 15 * 60 * 1000;   // retention: entries older than this are dropped on write
const WINDOW_MS = 10 * 60 * 1000; // counting window for the note
const THRESHOLD = 3;              // 3rd reference inside WINDOW_MS is the first note
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_NOTES = 3;              // one call can name several targets; do not narrate all of them

const POLL_EXT = /\.(?:log|txt|out|err|jsonl)$/i;
const READER = /(?:^|[\s(=])(?:tail|head|cat|type|rg|grep|Get-Content|sed\s+-n)\b/i;
// END-anchored: a path token, not a mention. An unanchored /journal\.jsonl/ would match a whole
// JSON payload that quotes such a path, making the blob itself the state key. A command that
// merely NAMES the file is not a read of it.
const JOURNAL = /(?:^|[\\/])journal\.jsonl$/i;
const TASK_OUTPUT = /[\\/]tasks[\\/][^\s"']+\.output$/i;
// Path-shaped: JSON blobs, glob patterns and quoted prose carry these characters, real paths
// do not. Length cap keeps a pathological token out of the state file.
function isPathToken(t) { return t.length > 0 && t.length <= 260 && !/[{}"'`|<>*?]/.test(t); }

// Transcripts reach tens of MB; the scan only runs when a target is about to be noted, but a file
// past this size is not read at all (no evidence -> silent).
const EVIDENCE_MAX_BYTES = 64 * 1024 * 1024;
const BACKGROUND_WORDS = /in the background|in background|being written to/i;

// The string that names a target in the launch record: the task id for tasks/<id>.output, the
// wf_ run directory for a Workflow journal.jsonl, the file name otherwise. '' = no way to tell.
function needleOf(key) {
  const parts = key.split('/');
  const base = parts.pop() || key;
  if (JOURNAL.test(key)) { const parent = parts.pop() || ''; return /^wf_/.test(parent) ? parent : ''; }
  if (TASK_OUTPUT.test(key)) return base.replace(/\.output$/, '');
  return base;
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join(' ');
  return '';
}

// True when the session transcript shows `needle` as the output of a backgrounded task. Fails
// CLOSED (false) on anything unreadable: a missed note costs a line, a wrong one costs a turn.
function backgroundEvidence(transcriptPath, needle) {
  try {
    if (!needle || typeof transcriptPath !== 'string' || !transcriptPath) return false;
    if (fs.statSync(transcriptPath).size > EVIDENCE_MAX_BYTES) return false;
    const named = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
      if (!line || !named.test(line)) continue;
      let rec;
      try { rec = JSON.parse(line); } catch (_) { continue; }
      const content = rec && rec.message && rec.message.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (!b) continue;
        if (rec.type === 'assistant' && b.type === 'tool_use' && b.input && b.input.run_in_background === true &&
            named.test(String(b.input.command || ''))) return true;
        if (rec.type === 'user' && b.type === 'tool_result') {
          const text = blockText(b.content);
          if (BACKGROUND_WORDS.test(text) && named.test(text)) return true;
        }
      }
    }
  } catch (_) { /* fail closed */ }
  return false;
}

// Shell-ish tokenizer: quoted spans stay whole so "C:/My Dir/build.log" is one token.
function tokenize(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    const t = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
    out.push(t.replace(/^[('"`]+/, '').replace(/[)'"`,;]+$/, ''));
  }
  return out;
}

// Key for the state map: slashes and case normalized, so C:\x\Build.LOG and c:/x/build.log
// are the same target.
function keyOf(p) { return String(p).replace(/\\/g, '/').toLowerCase(); }
function baseOf(p) { return keyOf(p).split('/').pop() || keyOf(p); }

function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return n + 'th';
  const rem10 = n % 10;
  return n + (rem10 === 1 ? 'st' : rem10 === 2 ? 'nd' : rem10 === 3 ? 'rd' : 'th');
}

// Poll targets referenced by one tool call. Deduped by key: a command naming the same file
// twice is one reference, not two.
function targetsFor(tool, ti) {
  const found = new Map();
  const add = (t) => { const k = keyOf(t); if (k && !found.has(k)) found.set(k, t); };

  if (tool === 'Read') {
    const fp = ti.file_path;
    if (typeof fp === 'string' && isPathToken(fp) && (JOURNAL.test(fp) || TASK_OUTPUT.test(fp))) add(fp);
    return [...found.entries()].map(([k, t]) => ({ key: k, base: baseOf(t) }));
  }

  const cmd = typeof ti.command === 'string' ? ti.command : '';
  if (!cmd) return [];

  // (1) and (2) apply to any path token anywhere in the command - those paths are only ever
  // touched to poll them.
  for (const t of tokenize(cmd)) if (isPathToken(t) && (JOURNAL.test(t) || TASK_OUTPUT.test(t))) add(t);

  // (3) needs a reader verb in the SAME segment as the file, so `npm test 2> build.log`
  // (a producer) does not read as a poll.
  for (const seg of cmd.split(/\|\||&&|[;|&\n]/)) {
    if (!READER.test(seg)) continue;
    for (const t of tokenize(seg)) if (isPathToken(t) && POLL_EXT.test(t)) add(t);
  }
  return [...found.entries()].map(([k, t]) => ({ key: k, base: baseOf(t) }));
}

function readState() {
  try {
    const all = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    return all && typeof all === 'object' ? all : {};
  } catch (_) { return {}; }
}

// Atomic: sibling sessions share this file, so never leave a half-written JSON behind.
// GC of sessions untouched for 24 h happens on every write.
function writeState(all, now) {
  for (const sid of Object.keys(all)) {
    const s = all[sid];
    if (!s || typeof s.last !== 'number' || now - s.last > SESSION_TTL_MS) delete all[sid];
  }
  const tmp = STATE + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, STATE);
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    const tool = input.tool_name || '';
    // Monitor is the RIGHT way to wait and is not routed here anyway.
    if (tool !== 'Bash' && tool !== 'PowerShell' && tool !== 'Read') process.exit(0);

    const ti = input.tool_input || {};
    const targets = targetsFor(tool, ti);
    if (!targets.length) process.exit(0); // no poll target: state is left untouched

    const now = Date.now();
    const sid = input.session_id || 'global';
    const all = readState();
    const sess = (all[sid] && typeof all[sid] === 'object' && all[sid].targets) ? all[sid] : { last: now, targets: {} };
    sess.last = now;

    const notes = [];
    for (const t of targets) {
      const hits = (Array.isArray(sess.targets[t.key]) ? sess.targets[t.key] : [])
        .filter((ts) => typeof ts === 'number' && now - ts < KEEP_MS);
      hits.push(now);
      sess.targets[t.key] = hits;

      const inWindow = hits.filter((ts) => now - ts < WINDOW_MS);
      if (inWindow.length < THRESHOLD || notes.length >= MAX_NOTES) continue;
      if (!backgroundEvidence(input.transcript_path, needleOf(t.key))) continue;
      // Oldest in the window, not the first stored: the list is normally chronological, but a
      // span read off position 0 would be wrong the moment it is not.
      const mins = Math.max(1, Math.round((now - Math.min.apply(null, inWindow)) / 60000));
      notes.push(
        'poll-guard: ' + ordinal(inWindow.length) + ' read of ' + t.base + ' in ' + mins + ' min. ' +
        'Background builds, Workflows and tasks notify on completion - do other work, or arm ONE ' +
        'Monitor on the terminal condition (gotchas.md "Claude Code harness"). This note is warn-only.'
      );
    }
    // Drop targets whose last reference has aged out, so the file cannot grow without bound.
    for (const k of Object.keys(sess.targets)) {
      const list = (sess.targets[k] || []).filter((ts) => typeof ts === 'number' && now - ts < KEEP_MS);
      if (list.length) sess.targets[k] = list; else delete sess.targets[k];
    }
    all[sid] = sess;
    writeState(all, now);

    if (notes.length) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notes.join(' ') },
      }));
    }
    process.exit(0);
  } catch (_) {
    process.exit(0); // fail open: a nudge must never wedge a tool call
  }
});
