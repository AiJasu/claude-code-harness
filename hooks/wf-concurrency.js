// Stop hook: after a multi-agent workflow finishes, report the concurrency it actually achieved.
//
// WHY: runs are sized in agents, and the only visible cost of one more agent is wall clock, which
// parallelism hides. Long single-agent stretches repeat unnoticed unless something prints them;
// hook-backed rules hold where prose-only rules break.
//
// Everything needed is in the run file's workflowProgress[] entries (startedAt, durationMs,
// tokens, toolCalls, model, label, phaseTitle) - no agent transcripts, no extra I/O.
//
// SPEAKS ONLY WHEN IT MATTERS. A hook that narrates every run becomes noise. Silent unless
// achieved concurrency is under 3 slots (CONCURRENCY_FLOOR, absolute), or the run spent most of its wall clock
// single-agent, or one two-agent phase holds a quarter of the run - see SERIAL_PHASE_* below.
//
// Standalone: node wf-concurrency.js <runfile.json>   prints the full per-agent table.
// Output contract: hookSpecificOutput.additionalContext on stdout is the one channel that
// reaches the model; stderr on exit 0 is user-display only. Always exit 0; fail open.
//
// RESULT-SIZE CHECK: the same run.json this hook already parses stores the workflow's returned
// value under .result. A script that returns its ENTIRE nested report object instead of a short
// summary gets truncated mid-token (~8 KB) when the harness inlines it into the calling
// session - pure loss, since the full text already lives in this run.json. The assertion is a
// structural fact about the payload, not a truncation claim - wording below says "returned",
// never "was truncated", so it holds under the harness ceiling too.
const RESULT_CHAR_FLOOR = 2000;  // target: a short summary object, under 2000 chars

// LONG-AGENT CHECK: every turn re-reads the agent's whole context, so an agent's cost grows
// roughly with the square of its length. The guidance is "aim each part at 10-40 turns and split
// any over 60"; the floor is set at 100 so the note flags only the expensive tail, not ordinary
// research.
// STOPPING RULE: if a note on this ever names an agent that could not have been split (one
// indivisible task), raise the floor; if it proves to be noise, delete the check.
const LONG_AGENT_CALLS = 100;

// RELAUNCH LEDGER: report() below only sees runs with >= MIN_AGENTS agents that ran >= MIN_RUN_MS -
// a deliberate floor, or every well-packed run would also earn a note. But that means nothing downstream
// of report() ever sees a 1- or 2-agent run. ledgerStats()/updateLedger() below write
// ~/.claude/.wf-slots-ledger.json, one entry per completed run keyed by its (normalized)
// scriptPath, BEFORE report()'s gate - so model-routing-guard.js can quote the prior measurement
// back at the NEXT launch of that same script. A Stop hook cannot itself warn before the run it
// describes has even started; this is the pre-launch half.
const fs = require('fs');
const path = require('path');
const os = require('os');

// The Workflow runtime's concurrent-agent cap, Math.min(16, Math.max(2, os.cpus().length - 2)),
// computed live so a CPU-count change cannot leave a stale figure in the notes. Display only.
// model-routing-guard.js repeats the formula (no cross-import). Exported so the fixtures derive
// their expected text from it and pass on any core count.
const SLOT_CAP = Math.min(16, Math.max(2, os.cpus().length - 2));
const MIN_AGENTS = 3;          // below this there is nothing to pack
const MIN_RUN_MS = 120000;     // ignore short runs; the target is long stragglers
// ABSOLUTE floor, not SLOT_CAP / 2: a fraction of the live cap would move the threshold with the
// CPU count and flag every run with fewer items than slots.
const CONCURRENCY_FLOOR = 3;
const SINGLE_AGENT_FLOOR = 0.5;
// THIRD GATE. The two floors above are whole-run AVERAGES, and a run can sit in the gap between
// them while half its wall clock is a two-agent tail (e.g. a critic phase running two agents back
// to back). Inside both thresholds the hook would say nothing. A phase at most this wide holding
// at least this share of the run is that tail.
// STOPPING RULE: a well-packed run that gets flagged for a small phase means the share floor goes
// up, not another carve-out.
const SERIAL_PHASE_MAX_AGENTS = 2;
const SERIAL_PHASE_MIN_SHARE = 0.25;
const SEEN = path.join(os.homedir(), '.claude', '.wf-concurrency-seen.json');
const LEDGER = path.join(os.homedir(), '.claude', '.wf-slots-ledger.json');
const LEDGER_MIN_RUN_MS = 60000;  // 1min floor to skip near-instant/aborted runs - well below
                                   // MIN_RUN_MS so a short single-agent run still gets recorded
const LEDGER_KEEP = 500;          // bound the ledger file; oldest entries evicted first

// Interval sweep over [startedAt, startedAt+durationMs]. Returns union span, agent time, the
// wall time with <=1 agent live, and mean concurrency over the union of agent activity (so
// harness idle time between phases still counts).
function analyze(agents) {
  const iv = agents
    .filter((a) => Number.isFinite(a.startedAt) && Number.isFinite(a.durationMs) && a.durationMs > 0)
    .map((a) => ({ s: a.startedAt, e: a.startedAt + a.durationMs }));
  if (iv.length < 2) return null;

  const pts = [];
  for (const { s, e } of iv) { pts.push({ t: s, d: 1 }); pts.push({ t: e, d: -1 }); }
  pts.sort((x, y) => x.t - y.t || x.d - y.d);

  const start = Math.min(...iv.map((i) => i.s));
  const end = Math.max(...iv.map((i) => i.e));
  let live = 0;
  let prev = start;
  let thinMs = 0;      // wall time with <= 1 agent live
  let agentMs = 0;
  for (const p of pts) {
    const span = p.t - prev;
    if (span > 0) {
      if (live <= 1) thinMs += span;
      agentMs += live * span;
    }
    live += p.d;
    prev = p.t;
  }
  const runMs = end - start;
  return { runMs, agentMs, thinMs, concurrency: runMs > 0 ? agentMs / runMs : 0, n: iv.length };
}

function mins(ms) { return (ms / 60000).toFixed(1); }

// Same interval-sweep math as analyze() above, but self-contained and gated only by
// LEDGER_MIN_RUN_MS - no MIN_AGENTS floor, and a 1-agent run is handled directly (a single agent
// spanning the whole run is trivially 1.0 of SLOT_CAP) rather than bailing out the way analyze()'s
// `iv.length < 2` guard does. Kept separate from analyze() rather than loosening its guard.
function ledgerStats(agents) {
  const iv = agents
    .filter((a) => Number.isFinite(a.startedAt) && Number.isFinite(a.durationMs) && a.durationMs > 0)
    .map((a) => ({ s: a.startedAt, e: a.startedAt + a.durationMs, d: a.durationMs }));
  if (!iv.length) return null;
  const start = Math.min(...iv.map((i) => i.s));
  const end = Math.max(...iv.map((i) => i.e));
  const runMs = end - start;
  if (runMs < LEDGER_MIN_RUN_MS) return null;
  let concurrency;
  if (iv.length === 1) {
    concurrency = 1;
  } else {
    const pts = [];
    for (const { s, e } of iv) { pts.push({ t: s, d: 1 }); pts.push({ t: e, d: -1 }); }
    pts.sort((x, y) => x.t - y.t || x.d - y.d);
    let live = 0, prev = start, agentMs = 0;
    for (const p of pts) {
      const span = p.t - prev;
      if (span > 0) agentMs += live * span;
      live += p.d;
      prev = p.t;
    }
    concurrency = runMs > 0 ? agentMs / runMs : 0;
  }
  const longestMs = Math.max(...iv.map((i) => i.d));
  return { runMs, concurrency, agentCount: iv.length, longestMs };
}

// Windows launches pass backslash paths (model-routing-guard.js reads tool_input.scriptPath
// as-is); normalize so a later lookup from either spelling, or either case, matches.
function normScriptPath(p) { return String(p || '').replace(/\\/g, '/').toLowerCase(); }

function updateLedger(scriptPath, s) {
  if (!scriptPath) return;
  const key = normScriptPath(scriptPath);
  let ledger = {};
  try { ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8')) || {}; } catch (_) {}
  ledger[key] = {
    slots: Number(s.concurrency.toFixed(2)),
    runMin: Number(mins(s.runMs)),
    agentCount: s.agentCount,
    longestMin: Number(mins(s.longestMs)),
    recordedAt: new Date().toISOString(),
  };
  const keys = Object.keys(ledger);
  if (keys.length > LEDGER_KEEP) {
    keys.sort((a, b) => (ledger[a].recordedAt || '').localeCompare(ledger[b].recordedAt || ''));
    for (const k of keys.slice(0, keys.length - LEDGER_KEEP)) delete ledger[k];
  }
  try { fs.writeFileSync(LEDGER, JSON.stringify(ledger)); } catch (_) {}
}

function recordLedger(run) {
  const agents = (run.workflowProgress || []).filter((e) => e.type === 'workflow_agent');
  const s = ledgerStats(agents);
  if (s) updateLedger(run.scriptPath, s);
}

// The widest-spanning phase that is SERIAL_PHASE_MAX_AGENTS agents or fewer and holds at least
// SERIAL_PHASE_MIN_SHARE of the run's wall clock, or null.
//
// Agents with no phaseTitle all group under ONE key rather than falling back to their label. That
// is deliberate and conservative: keying on the label would make every agent its own "phase", so
// any run with one long agent would trip this gate - the per-agent outlier the note already ranks,
// re-reported as a structural finding. The cost is that a genuine two-agent tail in a run that
// records no phase titles is missed. Positive evidence of a narrow phase, or silence.
//
// The phase must ALSO be starved, not merely narrow: mean concurrency ACROSS ITS OWN SPAN at or
// below SERIAL_PHASE_MAX_AGENTS. Without that clause the gate fires on a narrow phase inside a busy
// window, which is not a serial tail; it is a well-packed run with a small phase in it.
function concurrencyIn(agents, s, e) {
  const span = e - s;
  if (span <= 0) return 0;
  let agentMs = 0;
  for (const x of agents) {
    if (!Number.isFinite(x.startedAt) || !Number.isFinite(x.durationMs) || x.durationMs <= 0) continue;
    const os = Math.max(s, x.startedAt);
    const oe = Math.min(e, x.startedAt + x.durationMs);
    if (oe > os) agentMs += oe - os;
  }
  return agentMs / span;
}

function worstSerialPhase(agents, a) {
  const phases = new Map();
  for (const x of agents) {
    if (!Number.isFinite(x.startedAt) || !Number.isFinite(x.durationMs) || x.durationMs <= 0) continue;
    const title = String(x.phaseTitle || '');
    const p = phases.get(title) || { title, n: 0, s: Infinity, e: -Infinity };
    p.n++;
    p.s = Math.min(p.s, x.startedAt);
    p.e = Math.max(p.e, x.startedAt + x.durationMs);
    phases.set(title, p);
  }
  let worst = null;
  for (const p of phases.values()) {
    if (p.n > SERIAL_PHASE_MAX_AGENTS) continue;
    const spanMs = p.e - p.s;
    const share = a.runMs > 0 ? spanMs / a.runMs : 0;
    if (share < SERIAL_PHASE_MIN_SHARE) continue;
    if (concurrencyIn(agents, p.s, p.e) > SERIAL_PHASE_MAX_AGENTS) continue;
    if (!worst || spanMs > worst.spanMs) {
      worst = { title: p.title || '(unnamed phase)', n: p.n, spanMs, share };
    }
  }
  return worst;
}

function report(run) {
  const agents = (run.workflowProgress || []).filter((e) => e.type === 'workflow_agent');
  if (agents.length < MIN_AGENTS) return null;
  const a = analyze(agents);
  if (!a || a.runMs < MIN_RUN_MS) return null;

  const ranked = agents
    .filter((x) => Number.isFinite(x.durationMs))
    .sort((x, y) => y.durationMs - x.durationMs);
  const worst = ranked[0];
  const thinPct = Math.round((a.thinMs / a.runMs) * 100);
  const serial = worstSerialPhase(agents, a);

  return {
    name: run.workflowName || run.runId,
    concurrency: a.concurrency,
    thinPct,
    runMin: mins(a.runMs),
    agents,
    ranked,
    worst,
    serial,
    bad: a.concurrency < CONCURRENCY_FLOOR || a.thinMs / a.runMs >= SINGLE_AGENT_FLOOR || !!serial,
  };
}

// One clause per run, and the advice ONCE at the end. Repeating the remedy per run is how a
// useful signal becomes narration.
const MAX_REPORTED = 3;

function clause(r) {
  const w = r.worst
    ? ` longest "${r.worst.label || r.worst.agentId}" ${mins(r.worst.durationMs)}min` +
      (r.worst.toolCalls ? `/${r.worst.toolCalls} calls` : '')
    : '';
  // The serial-tail clause names the phase and its share: the third gate exists for runs that sit
  // inside both averages, and on those the phase itself is what needs reporting.
  const s = r.serial
    ? `, serial tail "${r.serial.title}" ${r.serial.n} agent(s) over ${mins(r.serial.spanMs)}min ` +
      `= ${Math.round(r.serial.share * 100)}% of the run`
    : '';
  return `${r.name} ${r.concurrency.toFixed(1)}of${SLOT_CAP} slots over ${r.runMin}min, ` +
         `${r.thinPct}% single-agent,${w}${s}`;
}

function note(runs) {
  const shown = runs.slice(0, MAX_REPORTED);
  const more = runs.length - shown.length;
  return (
    'wf-concurrency: ' + shown.map(clause).join('; ') +
    (more > 0 ? `; +${more} more run(s) the same shape` : '') +
    '. Split the long agent into file-exclusive parts or give it a turn budget; two separate ' +
    `Workflow calls each get their own ${SLOT_CAP} slots, one wide run does not.`
  );
}

// A structural fact about the payload, never a truncation claim - "returned", not "was
// truncated" - so the note stays accurate whether or not this particular run crossed the
// harness's own truncation point.
function resultSize(run) {
  if (run.result === undefined) return null;
  let len;
  try { len = JSON.stringify(run.result).length; } catch (_) { return null; }
  if (!(len > RESULT_CHAR_FLOOR)) return null;
  return { name: run.workflowName || run.runId, chars: len };
}

function resultClause(r) {
  return `${r.name} returned ${Math.round(r.chars / 1000)}k chars`;
}

function resultSizeNote(items) {
  const shown = items.slice(0, MAX_REPORTED);
  const more = items.length - shown.length;
  return (
    'wf-result-size: ' + shown.map(resultClause).join('; ') +
    (more > 0 ? `; +${more} more run(s) the same shape` : '') +
    `. Over the ${RESULT_CHAR_FLOOR}-char target; the harness inlines this into the calling ` +
    'session as a task-notification and truncates past ~8 KB mid-token - neither a ' +
    "summary nor parseable. Return a short object (headline/counts/report path) from the " +
    "script instead, and have the run's own last agent Write the full detail to a file."
  );
}

function longAgents(run) {
  const long = (run.workflowProgress || [])
    .filter((e) => e.type === 'workflow_agent' && (e.toolCalls || 0) > LONG_AGENT_CALLS)
    .sort((x, y) => y.toolCalls - x.toolCalls);
  if (!long.length) return null;
  return { name: run.workflowName || run.runId, n: long.length, worst: long[0] };
}

function longClause(r) {
  return `${r.name} ${r.n} agent(s), longest "${r.worst.label || r.worst.agentId}" ${r.worst.toolCalls} calls`;
}

function longNote(items) {
  const shown = items.slice(0, MAX_REPORTED);
  const more = items.length - shown.length;
  return (
    `wf-long-agent: over ${LONG_AGENT_CALLS} tool calls in ` + shown.map(longClause).join('; ') +
    (more > 0 ? `; +${more} more run(s) the same shape` : '') +
    '. Each turn re-reads the whole context, so cost grows with the square of agent length: ' +
    'split that stage into file-exclusive parts of 10-40 turns next time the script runs.'
  );
}

// --- standalone: full per-agent table ---
function standalone(file) {
  try {
    const run = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rs = resultSize(run);
    if (rs) console.log(`result: ${rs.chars} chars (floor ${RESULT_CHAR_FLOOR}) - over target, see wf-result-size note`);
    const r = report(run);
    if (!r) { console.log('not a multi-agent run, or too short to analyze'); process.exit(0); }
    console.log(`${r.name}  ${r.runMin}min  ${r.agents.length} agents  ` +
                `concurrency ${r.concurrency.toFixed(2)} of ${SLOT_CAP}  single-agent ${r.thinPct}%`);
    console.log('');
    console.log('  min    tools   tokens  model            phase / label');
    for (const x of r.ranked) {
      console.log(
        '  ' + mins(x.durationMs).padStart(5) +
        String(x.toolCalls == null ? '-' : x.toolCalls).padStart(8) +
        String(x.tokens == null ? '-' : x.tokens).padStart(9) +
        '  ' + String(x.model || '-').padEnd(16) +
        ' ' + String(x.phaseTitle || '-') + ' / ' + String(x.label || x.agentId || '-')
      );
    }
    console.log('');
    if (r.serial) {
      console.log(`serial tail: phase "${r.serial.title}", ${r.serial.n} agent(s), ` +
        `${mins(r.serial.spanMs)}min = ${Math.round(r.serial.share * 100)}% of the run`);
    }
    console.log(r.bad ? 'VERDICT: effectively serial - repack the phases.' : 'VERDICT: acceptable packing.');
  } catch (e) {
    console.log('could not read run file:', e.message);
  }
  process.exit(0);
}

// --- hook mode ---
function hookMode() {
  const chunks = [];
  process.stdin.on('data', (d) => chunks.push(d));
  process.stdin.on('end', () => {
    let out = null;
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const tp = input.transcript_path;
      const key = input.session_id || 'global';

      // HEARTBEAT, written before every early exit. Without it this hook is unfalsifiable: silent
      // on a well-packed run, silent on a session with no workflows, and silent if the harness never
      // invoked it - three states with one appearance. `_lastFired` is the only evidence that
      // settings.json hook wiring reached this process; check it, do not assume.
      let seen = {};
      try { seen = JSON.parse(fs.readFileSync(SEEN, 'utf8')) || {}; } catch (_) {}
      seen._lastFired = new Date().toISOString();
      seen._lastSession = key;
      seen._lastMode = !tp ? 'no-transcript' : 'hook';
      try { fs.writeFileSync(SEEN, JSON.stringify(seen)); } catch (_) {}

      if (!tp) process.exit(0);
      const dir = path.join(path.dirname(tp), path.basename(tp).replace(/\.jsonl$/, ''), 'workflows');
      if (!fs.existsSync(dir)) process.exit(0);

      const done = new Set(seen[key] || []);

      const fresh = [];
      const freshBig = [];
      const freshLong = [];
      for (const f of fs.readdirSync(dir)) {
        if (!/^wf_.*\.json$/.test(f) || done.has(f)) continue;
        let run;
        try { run = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
        if (run.status !== 'completed' && run.status !== 'failed') continue;  // still running
        done.add(f);
        recordLedger(run);          // before report()'s MIN_AGENTS/MIN_RUN_MS gate - see header
        const r = report(run);
        if (r && r.bad) fresh.push(r);
        const rs = resultSize(run);
        if (rs) freshBig.push(rs);
        const la = longAgents(run);
        if (la) freshLong.push(la);
      }

      seen[key] = [...done].slice(-200);
      try { fs.writeFileSync(SEEN, JSON.stringify(seen)); } catch (_) {}

      const notes = [];
      if (fresh.length) {
        fresh.sort((a, b) => b.thinPct - a.thinPct);
        notes.push(note(fresh));
      }
      if (freshBig.length) {
        freshBig.sort((a, b) => b.chars - a.chars);
        notes.push(resultSizeNote(freshBig));
      }
      if (freshLong.length) {
        freshLong.sort((a, b) => b.worst.toolCalls - a.worst.toolCalls);
        notes.push(longNote(freshLong));
      }
      if (notes.length) out = notes.join(' ');
    } catch (_) { /* fail open */ }

    if (out) {
      try {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'Stop', additionalContext: out },
        }));
      } catch (_) {}
    }
    process.exit(0);
  });
}

// Required as a module (the fixtures read SLOT_CAP): export only, run nothing.
module.exports = { SLOT_CAP };
if (require.main === module) {
  if (process.argv[2]) standalone(process.argv[2]);
  else hookMode();
}
