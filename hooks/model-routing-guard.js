#!/usr/bin/env node
// model-routing-guard.js - PreToolUse enforcement of the model-routing HARD RULE
// (global CLAUDE.md): every Agent tool call and every Workflow agent() call must pass
// an explicit model, or it silently inherits the session model (on Fable, that burns the
// weekly Fable cap on fan-out work; the prose rule alone was not enough).
//
// Matcher in settings.json: Agent|Task|Workflow|ScheduleWakeup (unanchored; an anchored
// ^(Agent|Task|Workflow)$ would make the ScheduleWakeup tick ledger below dead code).
//   Agent/Task  -> block if tool_input.model is missing (subagent_type "fork" exempt:
//                  forks always inherit by design). A model with no effort gets a
//                  non-blocking note: the subagent inherits the session's effort.
//   Workflow    -> statically scan the script (inline `script`, `scriptPath` file, or
//                  `name` resolved to <cwd>/.claude/workflows/<name>.js then
//                  ~/.claude/workflows/<name>.js) for agent() calls whose options omit
//                  a model key. Also scans one level of workflow('name'/{scriptPath})
//                  child references. Unresolvable names (built-ins) allow + warn.
//
// Block = exit 2 + stderr (same mechanism as guard-hook.js). Internal errors fail open.
// Standalone audit mode: node model-routing-guard.js --scan <file.js> [...]
//
// Only the missing model BLOCKS. Everything else here is a non-blocking note delivered on
// hookSpecificOutput.additionalContext, because a CLAUDE.md rule with no detector is a note
// (hook-backed rules hold; prose-only rules break). SIZE, TIER and LOOP and VERIFY back the
// rules whose cost is measurable (the GATE note was retired, see below):
//   LOOP   -> "a self-paced loop writes its exit contract before round 1"
//   VERIFY -> "right-size verification" (verify:build ratio, runs that build nothing at all)
// Both read MASKED source, so prompt text that merely mentions a loop or the word "verify"
// cannot trip them - the fixture suite pins exactly that.
// RETURN backs gotchas.md "The RETURN is inlined into the completion notification": the
// pre-launch half of wf-concurrency.js's post-hoc wf-result-size note.
//
// DELIBERATELY NOT extended to main-loop Agent calls, though the same rule governs them: a
// batch-size threshold over main-loop Agent calls never caught a genuine case and did misfire on
// correct ones, so it stays out.
// LEDGER note: non-blocking, reads ~/.claude/.wf-slots-ledger.json
// (written by wf-concurrency.js at Stop) and quotes a scriptPath's last recorded packing back at
// its NEXT launch when that run was under 3 slots - the pre-launch half of a check that would
// otherwise be entirely post-hoc. Silent with no entry, at 3 slots or better, for an inline script,
// when the recorded run had fewer than 3 agents (item-bound), and after it already spoke for that
// script in this session.
// Fixtures: node hooks/tests/model-routing-guard-fixtures.js (from the harness root)
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- JS-aware masking: blank out strings, template contents, comments, regex bodies
// (same length, newlines kept) so paren-depth walking and `model:` key checks only see
// real code. Template ${...} expressions stay visible (they are code).
function maskCode(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  let lastCode = ''; // last non-space char emitted as code, for regex-vs-divide heuristic
  const tplBraces = []; // per-template-nesting brace depth inside ${ }
  let mode = 'code'; // code | line | block | sq | dq | tpl | re
  const blank = (k) => { if (out[k] !== '\n') out[k] = ' '; };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; blank(i); blank(i + 1); i += 2; continue; }
      if (c === '/' && d === '*') { mode = 'block'; blank(i); blank(i + 1); i += 2; continue; }
      if (c === "'") { mode = 'sq'; i++; continue; }
      if (c === '"') { mode = 'dq'; i++; continue; }
      if (c === '`') { mode = 'tpl'; tplBraces.push(-1); i++; continue; }
      if (c === '/' && /[(,=:\[!&|?{};+\-*%~^<>]/.test(lastCode)) { mode = 're'; i++; continue; }
      if (c === '}' && tplBraces.length && tplBraces[tplBraces.length - 1] === 0) {
        // end of ${ }: back into template text
        tplBraces[tplBraces.length - 1] = -1; mode = 'tpl'; i++; continue;
      }
      if (c === '{' && tplBraces.length && tplBraces[tplBraces.length - 1] >= 0) tplBraces[tplBraces.length - 1]++;
      if (c === '}' && tplBraces.length && tplBraces[tplBraces.length - 1] > 0) tplBraces[tplBraces.length - 1]--;
      if (!/\s/.test(c)) lastCode = c;
      i++; continue;
    }
    if (mode === 'line') { if (c === '\n') mode = 'code'; else blank(i); i++; continue; }
    if (mode === 'block') { if (c === '*' && d === '/') { blank(i); blank(i + 1); mode = 'code'; i += 2; } else { blank(i); i++; } continue; }
    if (mode === 'sq' || mode === 'dq') {
      const q = mode === 'sq' ? "'" : '"';
      if (c === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      // lastCode must become the CLOSING QUOTE. Without this it stayed whatever
      // preceded the string, so `x = "10" / 2` saw lastCode '=' and read the `/` as the start of
      // a regex literal - blanking to end of line, and with it any agent() call on that line.
      if (c === q) { mode = 'code'; lastCode = q; i++; continue; }
      if (c === '\n') { mode = 'code'; i++; continue; } // unterminated; bail to code
      blank(i); i++; continue;
    }
    if (mode === 'tpl') {
      if (c === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (c === '`') { tplBraces.pop(); mode = 'code'; lastCode = '`'; i++; continue; }
      if (c === '$' && d === '{') { tplBraces[tplBraces.length - 1] = 0; mode = 'code'; i += 2; continue; }
      blank(i); i++; continue;
    }
    if (mode === 're') {
      if (c === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (c === '/') { mode = 'code'; lastCode = '/'; i++; while (i < n && /[a-z]/i.test(src[i])) i++; continue; }
      if (c === '\n') { mode = 'code'; i++; continue; } // not a regex after all; bail
      blank(i); i++; continue;
    }
  }
  return out.join('');
}

// RETIRED - the GATE note. DO NOT REBUILD IT; read this before proposing it again.
//
// The rule it tried to enforce is still true and still lives in CLAUDE.md: a workflow's pass test
// must be COMPUTED by the script from what a stage returned, never read off a pass/verdict field
// the checking agent wrote about its own work. What is retired is the CHECK, not the rule.
//
// It was a lexical pair - a branch on `.verdict`/`.pass` minus a whitelist clearing scripts that
// contained `findings` or `severity` near a filter. Over a large sample of workflow scripts it
// had zero true positives: every firing was correct code, including the adversarial-verify
// pattern the workflow-authoring skill PRESCRIBES (`votes.filter((v) => !v.refuted).length >= 2`).
// That is the root cause and it is not fixable by pattern: the banned shape and the prescribed one
// differ by WHOSE work the verdict judges - a skeptic refuting someone else's finding is the good
// shape, an agent grading itself is the bad one - and that distinction is semantic, invisible to
// any regex over the call site. A structural inversion was tried and was a near-no-op.
//
// Rule of thumb: a check that has never caught a true case but does misfire gets written up
// instead of deployed. SIZE, TIER, LOOP and VERIFY are untouched and still fire.

// Stage shapes that should not be paying opus rates by default: two-file verifiers and
// inventories are sonnet+medium or haiku work, not judgment work.
const VERIFY_SHAPED = /verify|refute|check|inventor|\blist\b|survey/i;

// Right-size verification (CLAUDE.md): these two vocabularies classify each agent() site from its
// label, phase and prompt; anything they cannot place stays unclassified rather than a forced call.
const VERIFY_TAG = /verif|refut|adversar|critiqu|critic|judge|skeptic|review|audit|validat|\bvote|\bgate\b|\blens\b|\bcheck/i;
const BUILD_TAG = /build|writ|draft|implement|generat|author|creat|\bfix\b|\bappl|migrat|refactor|integrat|assembl|\bspec\b|design|patch|\bedit/i;

// A loop that spawns agents needs a hard stop (CLAUDE.md exit contract).
// Run on MASKED source, so a PROMPT that merely contains "while (true)" cannot trip it.
// Bounded = the condition names a number, a .length, or a cap-ish identifier, or the loop consults
// budget. A queue-drain `while (q.length)` therefore reads as bounded, which is the intent.
const BOUND_COND = /\d|\.length\b|\b(?:max|cap|limit|round|tries|attempts|remaining)/i;
const BOUND_BUDGET = /\bbudget\s*\./;

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

// Index of the bracket closing the one at `open` (any of ( { [ ), or -1.
function closeOf(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const HAS_AGENT = /(?:^|[^\w$.])agent\s*\(/;

// while/for/do loops whose body spawns agents with nothing bounding the rounds.
function unboundedLoops(masked) {
  const hits = [];
  let m;
  const head = /\b(?:while|for)\s*\(/g;
  while ((m = head.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1;
    const condEnd = closeOf(masked, open);
    if (condEnd === -1) continue;
    const cond = masked.slice(open + 1, condEnd);
    let i = condEnd + 1;
    while (i < masked.length && /\s/.test(masked[i])) i++;
    let body;
    if (masked[i] === '{') {
      const bEnd = closeOf(masked, i);
      if (bEnd === -1) continue;
      body = masked.slice(i, bEnd);
    } else {
      const semi = masked.indexOf(';', i);
      body = masked.slice(i, semi === -1 ? masked.length : semi);
    }
    if (!HAS_AGENT.test(body)) continue;
    if (BOUND_COND.test(cond) || BOUND_BUDGET.test(cond + body)) continue;
    hits.push(lineOf(masked, m.index));
  }
  // do { ... } while (cond) - the head regex above sees only the trailing while, whose body is
  // empty, so this shape needs its own pass rather than a silent hole.
  const doHead = /\bdo\s*\{/g;
  while ((m = doHead.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1;
    const bEnd = closeOf(masked, open);
    if (bEnd === -1) continue;
    const body = masked.slice(open, bEnd);
    if (!HAS_AGENT.test(body)) continue;
    const tail = /while\s*\(([^)]*)\)/.exec(masked.slice(bEnd, bEnd + 200));
    const cond = tail ? tail[1] : '';
    if (BOUND_COND.test(cond) || BOUND_BUDGET.test(cond + body)) continue;
    hits.push(lineOf(masked, m.index));
  }
  return hits.sort((a, b) => a - b);
}

// --- RETURN smell -------------------------------------------------------------------------------
// A workflow's return value is inlined into the calling session's task-notification and cut
// mid-token past ~8 KB. wf-concurrency.js measures that only at Stop, after the payload has
// landed, and the prose rule (gotchas.md, "The RETURN is inlined") is not enough on its own.
// This reads the script BEFORE launch: a top-level return (brace depth 0) that hands back
// agent output itself - a name fed by agent()/parallel()/pipeline(), a chain on one, a spread or
// JSON.stringify of one, or an object/array literal holding one. POSITIVE EVIDENCE ONLY: a value
// passed through a local helper (`brief(out)`, `slim(det)`) or computed into a count, a comparison
// or a string reads as reduced and stays silent, so an unforeseen spelling misses rather than
// nags.
const AGENT_FN = new Set(['agent', 'parallel', 'pipeline']);
const AGENT_CALL = /(?:^|[^\w$.])(?:agent|parallel|pipeline)\s*\(/;
const IDENT = /^[A-Za-z_$][\w$]*/;

// End of the statement whose expression starts at `i`: the first `;`, an unmatched closer, or a
// newline at bracket depth 0 that neither follows an operator nor precedes a `.`/`?`/`:` chain.
function stmtEnd(s, i) {
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return k; depth--; }
    else if (depth === 0 && c === ';') return k;
    else if (depth === 0 && c === '\n') {
      const prev = /(\S)\s*$/.exec(s.slice(i, k));
      const next = /^\s*(\S)/.exec(s.slice(k + 1));
      if (prev && /[=+\-*/&|?:,.(]/.test(prev[1])) continue;
      if (next && /[.?:&|+]/.test(next[1])) continue;
      return k;
    }
  }
  return s.length;
}

// Split the inside of a bracket pair at its top-level commas.
function splitTop(s) {
  const parts = [];
  let depth = 0, from = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { parts.push(s.slice(from, k)); from = k + 1; }
  }
  parts.push(s.slice(from));
  return parts.map((p) => p.trim()).filter(Boolean);
}

// The value expressions of an object or array literal: property values, shorthand names and
// spread operands. Methods and getters are code, not data, and are skipped. `skipPathKeys`: a
// property NAMED as a location (reportPath, outDir, file, report) is the pointer the rule asks
// for, whatever produced it - a save agent's returned path is still a path.
const PATH_KEY = /path|file|dir|report/i;
function literalParts(e, skipPathKeys) {
  const out = [];
  for (let p of splitTop(e.slice(1, closeOf(e, 0)))) {
    if (p.startsWith('...')) { out.push(p.slice(3)); continue; }
    if (e[0] === '[') { out.push(p); continue; }
    let depth = 0, colon = -1;
    for (let k = 0; k < p.length; k++) {
      const c = p[k];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ':' && depth === 0) { colon = k; break; }
    }
    const key = colon !== -1 ? p.slice(0, colon) : p;
    if (skipPathKeys && PATH_KEY.test(key)) continue;
    if (colon !== -1) out.push(p.slice(colon + 1));
    else if (/^[A-Za-z_$][\w$]*$/.test(p)) out.push(p);
  }
  return out;
}

// Member/call chain from an identifier at the start of `s`: { end, last } where `last` is the
// final property name, '()' or '[]'. A `.` may continue the chain across a newline.
function chainOf(s) {
  const id = IDENT.exec(s);
  if (!id) return { end: 0, last: '', field: false };
  let k = id[0].length, last = id[0], field = false;
  for (;;) {
    const m = /^\s*\??\.\s*([A-Za-z_$][\w$]*)/.exec(s.slice(k));
    if (m) {
      k += m[0].length; last = m[1];
      if (!/^\s*(?:\?\.)?\(/.test(s.slice(k))) field = true; // `.name` read, not `.name(` called
      continue;
    }
    const o = s.slice(k).startsWith('?.') ? k + 2 : k;
    if (s[o] === '(' || s[o] === '[') {
      const c = closeOf(s, o);
      if (c === -1) break;
      last = s[o] === '(' ? '()' : '[]';
      k = c + 1;
      continue;
    }
    break;
  }
  return { end: k, last, field };
}

// True when a comparison sits at bracket depth 0 (the value is a boolean, not a payload).
function topCompare(e) {
  let depth = 0;
  for (let k = 0; k < e.length; k++) {
    const c = e[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && /[<>!=]/.test(c)) {
      const two = e.slice(k, k + 2);
      if (two === '=>' || (c === '=' && e[k - 1] === '>')) continue;
      if (c === '<' || c === '>' || two === '==' || two === '!=') return true;
    }
  }
  return false;
}

// Split `e` at a top-level operator: ternary branches, `||`/`??` operands, or the value operand
// of `&&` (the last one). Null-guards like `r && r.text || null` are a common way to spell a
// raw field, so each branch that can BE the value is judged on its own.
function valueBranches(e) {
  let depth = 0, q = -1;
  const ors = [], ands = [];
  for (let k = 0; k < e.length; k++) {
    const c = e[k], two = e.slice(k, k + 2);
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth !== 0) continue;
    else if (two === '||' || two === '??') { ors.push(k); k++; }
    else if (two === '&&') { ands.push(k); k++; }
    else if (two === '?.') k++;
    else if (c === '?' && q === -1) q = k;
  }
  if (q !== -1) {
    let d = 0, nested = 0;
    for (let k = q + 1; k < e.length; k++) {
      const c = e[k], two = e.slice(k, k + 2);
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') d--;
      else if (d === 0 && (two === '?.' || two === '??')) k++;
      else if (d === 0 && c === '?') nested++;
      else if (d === 0 && c === ':') { if (nested) nested--; else return [e.slice(q + 1, k), e.slice(k + 1)]; }
    }
    return null;
  }
  if (ors.length) {
    const cuts = [-2, ...ors, e.length];
    return cuts.slice(0, -1).map((c, i) => e.slice(c + 2, cuts[i + 1]));
  }
  if (ands.length) return [e.slice(ands[ands.length - 1] + 2)];
  return null;
}

// Does this expression hand back agent output as-is? `tainted` = names fed by agent output.
// `atReturn`: judging the returned value itself, where reading ONE named field of a fed value
// (`rep.path`, `synth.verdict`) is the author's own pick and reads as reduced. While tracing what
// feeds a name, a field stays fed: `const findings = r.findings` is still agent output.
function heavy(expr, tainted, atReturn) {
  let e = expr.trim().replace(/^await\s+/, '');
  while (e[0] === '(' && closeOf(e, 0) === e.length - 1) e = e.slice(1, -1).trim().replace(/^await\s+/, '');
  if (!e) return false;
  if (e[0] === '{' || e[0] === '[') return literalParts(e, atReturn).some((p) => heavy(p, tainted, atReturn));
  const branches = valueBranches(e); // before the prefix test: `typeof x === 's' ? a : b` is a ternary
  if (branches) return branches.some((b) => heavy(b, tainted, atReturn));
  if (/^(?:!|typeof\b|new\b)/.test(e) || topCompare(e)) return false;
  const js = /^JSON\s*\.\s*stringify\s*\(/.exec(e);
  if (js) {
    const args = splitTop(e.slice(js[0].length, closeOf(e, js[0].length - 1)));
    return args.length > 0 && heavy(args[0], tainted, atReturn);
  }
  const ch = chainOf(e);
  if (!ch.end || ch.end !== e.length) return false; // arithmetic, ternary, template: reduced
  if (ch.last === 'length' || ch.last === 'size') return false;
  const root = IDENT.exec(e)[0];
  if (AGENT_FN.has(root)) return true;
  if (!tainted.has(root) && !atReturn) {
    // Tracing only: a helper that takes agent output hands back agent output - `parse(raw)`,
    // `JSON.parse(text)`, `Object.values(byPart)` - the lenient-parser step most scripts have.
    const rest = e.slice(root.length);
    const groups = [];
    for (let k = 0; k < rest.length; k++) {
      if (rest[k] === '(' || rest[k] === '[') { const c = closeOf(rest, k); if (c === -1) break; groups.push(rest.slice(k + 1, c)); k = c; }
    }
    return groups.some((g) => splitTop(g).some((a) => heavy(a, tainted, false)));
  }
  if (!tainted.has(root) || (atReturn && ch.field)) return false;
  // A chain on a fed name stays raw through array plumbing; any other call is a reduction the scan
  // cannot size and is left alone. `.map(` counts as a reduction: field projections
  // (`results.map(r => ({ id: r.id, ok: r.ok }))`) are the usual shape of a small return. The one
  // exception is a map that hands each item back (`r => r || fallback`): raw, like filter.
  const rest = e.slice(root.length);
  const CALL = /\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = CALL.exec(rest))) {
    if (/^(?:filter|flat|flatMap|concat|sort|reverse)$/.test(m[1])) continue;
    if (m[1] !== 'map') return false;
    const open = m.index + m[0].length - 1;
    const close = closeOf(rest, open);
    if (close === -1 || !passThrough(splitTop(rest.slice(open + 1, close))[0] || '')) return false;
    CALL.lastIndex = close + 1; // the fallback inside the callback is not agent output
  }
  return true;
}

// A .map callback that returns its item unchanged: the arrow body (inside any parens) is the first
// parameter alone, or the first parameter followed by `||`/`??` and a fallback. `r => r.text || ''`
// is a field pick and does not qualify.
function passThrough(cb) {
  const m = /^(?:async\s+)?(?:\(\s*([A-Za-z_$][\w$]*)[^)]*\)|([A-Za-z_$][\w$]*))\s*=>\s*/.exec(cb);
  if (!m) return false;
  const p = m[1] || m[2];
  let body = cb.slice(m[0].length).trim();
  while (body[0] === '(' && closeOf(body, 0) === body.length - 1) body = body.slice(1, -1).trim();
  return body === p || new RegExp('^' + p.replace(/\$/g, '\\$') + '\\s*(?:\\|\\||\\?\\?)').test(body);
}

// Names in a binding pattern: `x`, `{ a, b: c, ...d }`, `[e, f = 1]`.
function patternNames(p) {
  p = p.trim();
  if (p[0] !== '{' && p[0] !== '[') return IDENT.test(p) ? [IDENT.exec(p)[0]] : [];
  const names = [];
  for (let part of splitTop(p.slice(1, closeOf(p, 0)))) {
    part = part.replace(/^\.\.\./, '');
    const colon = p[0] === '{' ? part.indexOf(':') : -1;
    if (colon !== -1) part = part.slice(colon + 1);
    names.push(...patternNames(part.split('=')[0]));
  }
  return names;
}

// Names fed by agent output, to a fixpoint: declarations and reassignments whose right side holds
// an agent call or a raw chain on a fed name, X.push(...) / X[k] = ... with such a value, and
// for-of loop variables over a fed collection.
function agentFed(masked) {
  const sites = []; // [names[], rhs]
  let m;
  const decl = /\b(?:const|let|var)\s+(\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*=(?![=>])/g;
  while ((m = decl.exec(masked)) !== null) {
    const from = m.index + m[0].length;
    sites.push([patternNames(m[1]), masked.slice(from, stmtEnd(masked, from))]);
  }
  const assign = /(?:^|[;\n{}])\s*([A-Za-z_$][\w$]*)((?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[[^\]\n]*\])*)\s*(?:\|\||\?\?|\+)?=(?![=>])/g;
  while ((m = assign.exec(masked)) !== null) {
    if (/^(?:const|let|var|return)$/.test(m[1])) continue;
    const from = m.index + m[0].length;
    sites.push([[m[1]], masked.slice(from, stmtEnd(masked, from))]);
  }
  const push = /\b([A-Za-z_$][\w$]*)\s*\.\s*(?:push|unshift)\s*\(/g;
  while ((m = push.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(masked, open);
    if (close === -1) continue;
    for (const a of splitTop(masked.slice(open + 1, close))) sites.push([[m[1]], a.replace(/^\.\.\./, '')]);
  }
  const forOf = /\bfor\s*\(\s*(?:const|let|var)\s+(\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*)\s+of\b/g;
  while ((m = forOf.exec(masked)) !== null) {
    const open = masked.indexOf('(', m.index);
    const close = closeOf(masked, open);
    if (close === -1) continue;
    sites.push([patternNames(m[1]), masked.slice(m.index + m[0].length, close)]);
  }
  // NOT tracked: callback parameters (`results.forEach((r) => ...)`). Tracking them adds false
  // notes on small returns.
  const fed = new Set();
  for (let pass = 0; pass < 12; pass++) {
    let grew = false;
    for (const [names, rhs] of sites) {
      if (names.every((n) => fed.has(n))) continue;
      const e = rhs.trim();
      const viaCall = AGENT_CALL.test(e) && !topCompare(e) && !/\.\s*(?:length|size)\s*$/.test(e);
      if (viaCall || heavy(e, fed)) { for (const n of names) if (!fed.has(n)) { fed.add(n); grew = true; } }
    }
    if (!grew) break;
  }
  return fed;
}

// The script's LAST top-level (brace depth 0) return, when it hands back agent output: [line] or [].
// Only the last: an earlier `if (!saved) return full` is the deliberate keep-the-results fallback
// for a failed save, which report-writing scripts commonly carry.
function heavyReturns(masked) {
  let depth = 0, last = null;
  for (let k = 0; k < masked.length; k++) {
    const c = masked[k];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0 && c === 'r' && masked.startsWith('return', k) &&
      !/[\w$.]/.test(masked[k - 1] || '') && !/[\w$]/.test(masked[k + 6] || '')) {
      const end = stmtEnd(masked, k + 6);
      last = { at: k, expr: masked.slice(k + 6, end) };
      k = Math.max(k, end - 1);
    }
  }
  if (!last || !heavy(last.expr, agentFed(masked), true)) return [];
  return [lineOf(masked, last.at)];
}

// Count the entries of the meta.phases array (top-level commas + 1), falling back to phase()
// call sites. Used only for the non-blocking size warning.
function countPhases(masked) {
  let n = 0;
  const m = /phases\s*:\s*\[/.exec(masked);
  if (m) {
    const open = m.index + m[0].length - 1;
    let depth = 0, close = -1;
    const cuts = [open];
    for (let i = open; i < masked.length; i++) {
      const c = masked[i];
      if (c === '[' || c === '{' || c === '(') depth++;
      else if (c === ']' || c === '}' || c === ')') { depth--; if (depth === 0) { close = i; break; } }
      else if (c === ',' && depth === 1) cuts.push(i);
    }
    if (close > open) {
      cuts.push(close);
      // count non-empty segments, so a trailing comma does not invent a phase
      for (let i = 0; i < cuts.length - 1; i++) if (masked.slice(cuts[i] + 1, cuts[i + 1]).trim()) n++;
    }
  }
  const calls = (masked.match(/(?:^|[^\w$.])phase\s*\(/g) || []).length;
  return Math.max(n, calls);
}

// Scan one script's source. Returns { violations, warnings, stats }.
function scanScript(src) {
  const masked = maskCode(src);
  const violations = [], warnings = [];
  const stats = {
    sites: 0, phases: countPhases(masked), fanout: /\bparallel\s*\(|\.map\s*\(/.test(masked),
    opus: 0, modeled: 0, verifyOpus: [],
    verify: 0, build: 0, loops: unboundedLoops(masked), returns: heavyReturns(masked),
    // Phase titles are strings, so they are only visible in the RAW source (script-level hint).
    titlesVerify: VERIFY_SHAPED.test((src.match(/title\s*:\s*['"][^'"]+['"]/g) || []).join(' ')),
  };
  const re = /agent\s*\(/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const before = masked[m.index - 1];
    if (before && /[\w$.]/.test(before)) continue; // subagent(, x.agent( etc.
    // walk from the open paren to its match, tracking top-level commas
    const open = m.index + m[0].length - 1;
    let depth = 0, firstComma = -1, close = -1;
    for (let i = open; i < masked.length; i++) {
      const c = masked[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) { close = i; break; } }
      else if (c === ',' && depth === 1 && firstComma === -1) firstComma = i;
    }
    const line = lineOf(masked, m.index);
    stats.sites++;
    if (close === -1) { warnings.push({ line, kind: 'unparseable call' }); continue; }
    if (firstComma === -1) { violations.push({ line, kind: 'no options argument (model missing)' }); continue; }
    const optsMasked = masked.slice(firstComma + 1, close);
    const optsRaw = src.slice(firstComma + 1, close);

    // Classify the site for the verify:build ratio. Label and phase are the author's own naming
    // and win over prompt text; a site neither vocabulary places is left uncounted.
    const label = (/label\s*:\s*['"]([^'"]+)['"]/.exec(optsRaw) || [])[1] || '';
    const phase = (/phase\s*:\s*['"]([^'"]+)['"]/.exec(optsRaw) || [])[1] || '';
    const firstArg = src.slice(open + 1, firstComma).slice(0, 200);
    const named = label + ' ' + phase;
    const tag = VERIFY_TAG.test(named) ? 'verify'
      : BUILD_TAG.test(named) ? 'build'
      : VERIFY_TAG.test(firstArg) ? 'verify'
      : BUILD_TAG.test(firstArg) ? 'build' : '';
    if (tag) stats[tag]++;

    // KEY POSITION, not merely "the token model appears". An earlier version widened
    // `model\s*:` to `model\s*[:,}]` so ES6 shorthand `{ model, effort }` /
    // `{ effort, model }` would stop being reported as "no model key" and BLOCKED. That widening
    // also accepted `model` used as a VALUE - `{ label: model }`, `{ tools: model }`, a template
    // `${model}` - which names no model at all: a fail-open of the one guarantee this hook exists
    // to enforce, and the direction that costs a silent Fable fan-out.
    // So the token must be in KEY position: preceded by `{` or `,` (whitespace allowed) and
    // followed by `,` `}` or `:`. The (?<!\$) rules out the `{` of a `${...}` interpolation,
    // which maskCode deliberately leaves visible because it is code.
    // optsMasked has its strings blanked, so the word "model" inside a prompt cannot satisfy this;
    // the optsRaw arm covers a quoted key, which masking would otherwise erase.
    const hasModel = /(?<!\$)[{,]\s*model\s*[:,}]/.test(optsMasked) || /["']model["']\s*:/.test(optsRaw);
    if (hasModel) {
      // Tier smell (non-blocking): which tier this site names, and whether a verify-shaped
      // stage is paying opus rates for two-file checking.
      const mv = /model\s*:\s*['"]([^'"]+)['"]/.exec(optsRaw);
      if (mv) {
        stats.modeled++;
        if (/opus/i.test(mv[1])) {
          stats.opus++;
          // Per-site only: the site's own label and prompt. Script-wide phase titles are a
          // separate, script-level signal - applied per site they would mark every agent in
          // any workflow that happens to have one verify phase.
          if (VERIFY_SHAPED.test(label + ' ' + firstArg)) stats.verifyOpus.push(line);
        }
      }
      continue;
    }
    if (/^\s*\{/.test(optsMasked)) violations.push({ line, kind: 'options object has no model key' });
    else warnings.push({ line, kind: 'options passed via variable - verify it sets model' });
  }
  return { violations, warnings, stats };
}

// Resolve child workflow('name') / workflow({scriptPath}) references, one level.
function childRefs(src, cwd) {
  const files = [];
  let m;
  const nameRe = /\bworkflow\(\s*(['"])([\w-]+)\1/g;
  while ((m = nameRe.exec(src)) !== null) {
    const f = resolveName(m[2], cwd);
    if (f) files.push(f);
  }
  const pathRe = /\bworkflow\(\s*\{\s*scriptPath\s*:\s*(['"])([^'"]+)\1/g;
  while ((m = pathRe.exec(src)) !== null) files.push(m[2]);
  return files;
}

function resolveName(name, cwd) {
  const cands = [
    cwd ? path.join(cwd, '.claude', 'workflows', name + '.js') : null,
    path.join(os.homedir(), '.claude', 'workflows', name + '.js'),
  ].filter(Boolean);
  for (const f of cands) { try { if (fs.statSync(f).isFile()) return f; } catch (_) {} }
  return null;
}

function scanSources(sources /* [{label, text, cwd}] */) {
  const violations = [], warnings = [];
  const total = {
    sites: 0, phases: 0, fanout: false, opus: 0, modeled: 0, verifyOpus: [],
    titlesVerify: false,
    verify: 0, build: 0, loops: [], returns: [],
  };
  const seen = new Set();
  const queue = [...sources];
  while (queue.length) {
    const s = queue.shift();
    if (seen.has(s.label)) continue;
    seen.add(s.label);
    const r = scanScript(s.text);
    for (const v of r.violations) violations.push(`${s.label}:${v.line} - ${v.kind}`);
    for (const w of r.warnings) warnings.push(`${s.label}:${w.line} - ${w.kind}`);
    total.sites += r.stats.sites;
    total.phases += r.stats.phases;
    total.fanout = total.fanout || r.stats.fanout;
    total.opus += r.stats.opus;
    total.modeled += r.stats.modeled;
    total.verify += r.stats.verify;
    total.build += r.stats.build;
    for (const l of r.stats.loops) total.loops.push(`${s.label}:${l}`);
    for (const l of r.stats.returns) total.returns.push(`${s.label}:${l}`);
    total.titlesVerify = total.titlesVerify || r.stats.titlesVerify;
    for (const l of r.stats.verifyOpus) total.verifyOpus.push(`${s.label}:${l}`);
    for (const f of childRefs(s.text, s.cwd)) {
      try { queue.push({ label: f, text: fs.readFileSync(f, 'utf8'), cwd: s.cwd }); } catch (_) {}
    }
  }
  return { violations, warnings, stats: total };
}

// Non-blocking TIER smell. Build stages tend to default to opus; the rule says writers-from-a-finished-spec are sonnet+high or opus+medium and
// two-file verifiers and inventories are sonnet+medium or haiku. This does not re-tier anything,
// it asks for the justification in the launch message.
// (The GATE smell used to sit here. Retired with zero true positives; the reasoning is recorded
// at the top of this file. Do not rebuild it.)

// Non-blocking LOOP smell - the exit contract. This asks whether the loop can stop without a human.
function loopNote(stats) {
  if (!stats.loops.length) return '';
  return `loop smell: agent() runs inside a loop with no round cap and no budget guard at ` +
    `${stats.loops.slice(0, 3).join(', ')}. Write the exit contract before round 1: a hard stop ` +
    '(N rounds, or no NEW criticals), a budget.remaining() guard, and a decided-items ledger so a ' +
    'round cannot re-raise what an earlier one rejected.';
}

// Non-blocking RETURN smell - the payload the completion notification will carry.
function returnNote(stats) {
  if (!stats.returns.length) return '';
  return `return smell: the script returns agent output at ${stats.returns.slice(0, 3).join(', ')}. ` +
    'The return is inlined into the task-notification and cut mid-token past ~8 KB. Have the last ' +
    'agent Write the detail to a file and return a headline: counts and that path.';
}

// Non-blocking VERIFICATION-WEIGHT smell. One note at most, most specific shape first, since a
// second sentence about the same numbers is just narration.
function verifyNote(stats) {
  const { verify, build, sites } = stats;
  if (!verify) return '';
  const counts = `${verify} verify-shaped / ${build} build-shaped of ${sites} agent sites`;
  // sites >= 3, because the remedy this note offers IS one or two agents - telling a two-agent
  // report to be a two-agent report is the kind of always-on nagging that gets a hook ignored.
  if (!build && sites >= 3) {
    return `verification smell: ${counts} - no build or apply stage. Name what will CHANGE when this ` +
      'finishes; if the answer is nothing it is a report, and one or two agents is the right size.';
  }
  // Site counts are not agent counts: one agent() inside a .map() is a fleet. A script that fans
  // out is not a single-item task whatever its site count says, so this branch stays out of its
  // way rather than calling a 100-agent research run single-item.
  if (build === 1 && verify >= 2 && !stats.fanout) {
    return `verification smell: ${counts} - a single-item task gets at most ONE verify agent, and often ` +
      'none when the main loop already read the primary source.';
  }
  if (verify >= 2 * build && sites >= 6) {
    return `verification smell: ${counts} - spend the verify budget on the CHANGE, taken out of the ` +
      'audit fan-out rather than added to it.';
  }
  return '';
}

function tierNote(stats) {
  const parts = [];
  if (stats.modeled >= 3 && stats.opus / stats.modeled > 0.7) {
    parts.push(`routing smell: ${stats.opus} of ${stats.modeled} agent sites are opus` +
      (stats.titlesVerify ? ' and its phase titles name verify/check stages' : ''));
  }
  if (stats.verifyOpus.length) {
    parts.push(`verify/inventory-shaped stages on opus at ${stats.verifyOpus.slice(0, 4).join(', ')}`);
  }
  if (!parts.length) return '';
  return parts.join('; ') + '. Writers and transcribers from a finished spec are sonnet+high or ' +
    'opus+medium; two-file verifiers and inventories are sonnet+medium or haiku. ' +
    'Justify the tiering in the launch message or re-tier.';
}

// Non-blocking SIZE prompt. Build and audit scale was chosen unilaterally in-window - never
// stated, never checkpointed - so a large launch is asked to say its size in one line first.
// Thresholds: more than 3 phases, 12+ agent sites, or fan-out with 4+ sites. Deliberately not
// 4 sites flat: at that level every routine workflow trips it and the warning stops being read.
function sizeNote(label, stats) {
  const big = stats.phases > 3 || stats.sites >= 12 || (stats.fanout && stats.sites >= 4);
  if (!big) return '';
  return `workflow ${label}: ${stats.phases || '?'} phases / ${stats.sites} agent sites` +
    (stats.fanout ? ' (fan-out detected)' : '') +
    '. State in the launching message what will exist when it finishes, in counts, and the ' +
    'smallest version that satisfies the ask; if the user is present, wait one beat for a steer. ' +
    'An apply or mechanical-edit stage gets deterministic checks, never a critic-agent phase.';
}

const TIERS = 'haiku = mechanical, sonnet = fact-gathering/search/extract, opus = judgment/verify/review; ' +
  "model:'fable' only as a deliberate choice for at most one hard synthesis agent - never by omission";

// --- the OTHER half of the loop exit contract -------------------------------------------------
// unboundedLoops() only sees loops written INSIDE a workflow script. An expensive loop can also be
// the built-in /loop re-arming itself through ScheduleWakeup, with the pass bar living in a
// critic's prose rubric - invisible to any script scan. Intent is not
// readable, but the tick count and the tool's own noop flag are facts, and CLAUDE.md already sets
// the limit: two idle ticks end it. Ledger is per session; stop:true clears the entry.
const TICKS = path.join(os.homedir(), '.claude', '.loop-ticks.json');

function loopTick(key, inp) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(TICKS, 'utf8')) || {}; } catch (_) {}
  if (inp.stop === true) {
    delete all[key];
    try { fs.writeFileSync(TICKS, JSON.stringify(all)); } catch (_) {}
    return '';
  }
  const e = all[key] || { n: 0, noopStreak: 0 };
  e.n++;
  e.noopStreak = inp.noop === true ? e.noopStreak + 1 : 0;
  all[key] = e;
  try { fs.writeFileSync(TICKS, JSON.stringify(all)); } catch (_) {}

  if (e.noopStreak >= 2) {
    return `loop exit contract: ${e.noopStreak} consecutive idle ticks. CLAUDE.md ends a self-paced ` +
      'loop at two - call ScheduleWakeup with stop:true rather than re-arming; a longer delay does ' +
      'not fix an idle loop. A no-op tick re-reads the whole context.';
  }
  // Every fifth re-arm, not every one after the fifth: a note repeated per tick is the narration
  // that makes a many-wake-up loop expensive in the first place.
  if (e.n >= 5 && e.n % 5 === 0) {
    return `loop exit contract: this loop has re-armed ${e.n} times. Name the hard stop now - a round ` +
      'cap, or "no NEW criticals" computed in the script from structured findings - or stop and report. ' +
      'A critique loop that runs without one keeps burning tokens until the user ends it.';
  }
  return '';
}

// --- relaunch-packing ledger --------------------------------------------------------------------
// wf-concurrency.js writes one entry per completed run into this file, keyed by the launching
// script's (normalized) path, BEFORE its own MIN_AGENTS/MIN_RUN_MS gate - so a 1- or 2-agent run
// is in here even though it never earns a post-hoc Stop note. Read here, at THIS launch, before
// the run starts: a Stop hook cannot itself warn ahead of the run it describes. 3 slots matches
// wf-concurrency.js's own CONCURRENCY_FLOOR (absolute 3); the cap shown beside it is
// wf-concurrency.js's SLOT_CAP formula. Both are duplicated rather than imported, so this blocking
// hook has no cross-file dependency.
const LEDGER = path.join(os.homedir(), '.claude', '.wf-slots-ledger.json');
const LEDGER_SLOT_FLOOR = 3;
const SLOT_CAP = Math.min(16, Math.max(2, os.cpus().length - 2));
// Speak-once memory: repeats for the same script, and notes on 1-2 agent runs, changed no launch.
// {sessionId: {scriptKey: 1}}, newest session last, capped so the file cannot grow.
const LEDGER_SPOKEN = path.join(os.homedir(), '.claude', '.wf-ledger-spoken.json');
const LEDGER_SPOKEN_KEEP = 40;

function normScriptPath(p) { return String(p || '').replace(/\\/g, '/').toLowerCase(); }

// True the FIRST time this session is told about this script, and records it. An unreadable or
// unwritable file means "first time": the old behavior (speak every launch), never a block.
function firstLedgerSpeech(sessionKey, scriptKey) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(LEDGER_SPOKEN, 'utf8')) || {}; } catch (_) {}
  const mine = all[sessionKey] || {};
  if (mine[scriptKey]) return false;
  mine[scriptKey] = 1;
  delete all[sessionKey];
  all[sessionKey] = mine;
  const ids = Object.keys(all);
  for (const id of ids.slice(0, Math.max(0, ids.length - LEDGER_SPOKEN_KEEP))) delete all[id];
  try { fs.writeFileSync(LEDGER_SPOKEN, JSON.stringify(all)); } catch (_) {}
  return true;
}

function ledgerNote(scriptPath, sessionKey) {
  if (!scriptPath) return '';
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (_) { return ''; }
  const scriptKey = normScriptPath(scriptPath);
  const e = ledger && ledger[scriptKey];
  if (!e || !(e.slots < LEDGER_SLOT_FLOOR)) return '';
  // A run with fewer agents than the floor can never reach it: it is item-bound (a 1-2 item
  // review is one facts agent plus one verify agent), which CLAUDE.md already calls structural.
  // An entry with no agentCount compares false and keeps the old behavior. Checked BEFORE the
  // speak-once memory so a silent case never uses up the script's one note.
  if (e.agentCount < LEDGER_SLOT_FLOOR) return '';
  if (!firstLedgerSpeech(sessionKey || 'global', scriptKey)) return '';
  return `wf-slots-ledger: this script's last recorded run packed ${e.slots} of ${SLOT_CAP} slots over ` +
    `${e.runMin}min with ${e.agentCount} agent(s), longest ${e.longestMin}min - under the ` +
    `${LEDGER_SLOT_FLOOR}-slot packing floor. Split the long agent or widen this phase before relaunching.`;
}

function block(reason) { process.stderr.write(reason); process.exit(2); }

// --- standalone audit mode ---
if (process.argv[2] === '--scan') {
  let bad = 0;
  for (const f of process.argv.slice(3)) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { console.log(`${f}: UNREADABLE (${e.message})`); bad++; continue; }
    const { violations, warnings, stats } = scanSources([{ label: f, text, cwd: path.dirname(path.dirname(path.dirname(f))) }]);
    if (!violations.length && !warnings.length) console.log(`${f}: OK (all agent() calls carry an explicit model)`);
    for (const v of violations) { console.log(`VIOLATION ${v}`); bad++; }
    for (const w of warnings) console.log(`WARNING   ${w}`);
    const size = sizeNote(f, stats);
    if (size) console.log(`SIZE      ${size}`);
    const tier = tierNote(stats);
    if (tier) console.log(`TIER      ${tier}`);
    const loop = loopNote(stats);
    if (loop) console.log(`LOOP      ${loop}`);
    const vfy = verifyNote(stats);
    if (vfy) console.log(`VERIFY    ${vfy}`);
    const ret = returnNote(stats);
    if (ret) console.log(`RETURN    ${ret}`);
  }
  process.exit(bad ? 1 : 0);
}

// --- hook mode ---
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    const tool = input.tool_name || '';
    const inp = input.tool_input || {};
    const cwd = input.cwd || process.cwd();

    if (tool === 'Agent' || tool === 'Task') {
      if (inp.subagent_type === 'fork') process.exit(0); // forks always inherit by design
      if (!inp.model) {
        block(
          'Model-routing HARD RULE (global CLAUDE.md): this Agent call has no explicit "model" - ' +
          'it would inherit the session model (on Fable, that burns the weekly Fable cap). ' +
          'Retry the same call with model set: ' + TIERS + '.'
        );
      }
      // EFFORT note: warn-only, never a block. An Agent call that names a model but no effort runs
      // the subagent at the SESSION's effort, and a mid-session /effort is saved as a per-model
      // default, so plain subagents can quietly run at xhigh. Leaving it unset is legitimate, hence
      // a note, not a rule. STOPPING RULE: no drop in effort-less Agent calls = delete this note.
      // ONCE PER SESSION: a parallel batch is sent before the model can read the first note, so a
      // per-call note repeats uselessly. Model-only (no systemMessage): the user cannot act on it.
      // The instruction itself lives in CLAUDE.md model routing, because the Agent tool's own text
      // says to omit effort unless CLAUDE.md or a skill asks. Memory reuses the ledger's speak-once
      // file under a sentinel key.
      if (!inp.effort && firstLedgerSpeech(input.session_id || 'global', ':agent-effort-note')) {
        const msg = 'model-routing-guard (non-blocking, once per session): this Agent call names a model but no ' +
          "effort, so the subagent runs at the session's effort level, and a saved /effort can have made " +
          'that xhigh. Pass effort: high for judgment, review and critic work, medium for ports, sweeps and ' +
          'transcription; leave it unset only when the session value is what you want.';
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg },
        }));
      }
      process.exit(0);
    }

    if (tool === 'ScheduleWakeup') {
      const msg = loopTick(input.session_id || 'global', inp);
      if (msg) {
        process.stdout.write(JSON.stringify({
          systemMessage: msg,
          hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg },
        }));
      }
      process.exit(0);
    }

    if (tool === 'Workflow') {
      const sources = [];
      if (typeof inp.script === 'string' && inp.script.trim()) {
        sources.push({ label: 'inline script', text: inp.script, cwd });
      } else if (inp.scriptPath) {
        try { sources.push({ label: inp.scriptPath, text: fs.readFileSync(inp.scriptPath, 'utf8'), cwd }); }
        catch (_) { process.exit(0); } // unreadable path: the runtime will error anyway
      } else if (inp.name) {
        const f = resolveName(inp.name, cwd);
        if (!f) {
          // additionalContext reaches the MODEL (systemMessage is user-display only) - the
          // instruction must land where it can act on it.
          const msg = `model-routing-guard: saved workflow "${inp.name}" did not resolve to a script file ` +
            '(built-in?). Cannot verify its agent() calls pass explicit models - confirm before large fan-out.';
          process.stdout.write(JSON.stringify({
            systemMessage: msg,
            hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg },
          }));
          process.exit(0);
        }
        sources.push({ label: f, text: fs.readFileSync(f, 'utf8'), cwd });
      } else {
        process.exit(0);
      }

      const { violations, warnings, stats } = scanSources(sources);
      if (violations.length) {
        block(
          'Model-routing HARD RULE (global CLAUDE.md): this workflow script has agent() calls without an ' +
          'explicit opts.model - every one would inherit the session model (on Fable, the weekly cap). Offending calls:\n' +
          violations.map((v) => '  - ' + v).join('\n') +
          '\nFix: add model per tier (' + TIERS + '). ' +
          'If launching by name, edit the script FILE listed above, then relaunch via scriptPath ' +
          '(name-launch can serve a stale cached copy).'
        );
      }
      const notes = [];
      if (inp.scriptPath) {
        const ledgerMsg = ledgerNote(inp.scriptPath, input.session_id);
        if (ledgerMsg) notes.push(ledgerMsg);
      }
      if (warnings.length) {
        notes.push('model-routing-guard (non-blocking): could not statically verify a model on: ' +
          warnings.join('; ') + '. Confirm those opts set an explicit model.');
      }
      const size = sizeNote(sources[0].label, stats);
      if (size) notes.push(size);
      const tier = tierNote(stats);
      if (tier) notes.push(tier);
      const loop = loopNote(stats);
      if (loop) notes.push(loop);
      const vfy = verifyNote(stats);
      if (vfy) notes.push(vfy);
      const ret = returnNote(stats);
      if (ret) notes.push(ret);
      if (notes.length) {
        const msg = notes.join(' ');
        process.stdout.write(JSON.stringify({
          systemMessage: msg,
          hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg },
        }));
      }
      process.exit(0);
    }

    process.exit(0);
  } catch (_) {
    process.exit(0); // fail open: never let a guard bug block legitimate work
  }
});
