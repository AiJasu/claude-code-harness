// PostToolUse / PostToolUseFailure hook for Bash AND PowerShell.
// Appends one JSONL line per failed shell call to bash-errors.jsonl, tagged with tool_name.
// PowerShell is logged too (when the PowerShell tool is enabled), so the /wrap
// gotcha-distillation loop is not half-blind.
// Dumb by design: logs every non-zero exit. /wrap filters real mistakes from noise
// and distills durable rules into gotchas.md. Always exits 0; never affects the tool.

const fs = require('fs');

const LOG = require('path').join(require('os').homedir(), '.claude', 'bash-errors.jsonl');
const MAX_STDERR = 1500;
const HEAD_KEEP = 300;

// Keep the HEAD and the TAIL of a long failed output, not just the head: the line that names the
// cause is often the LAST one (an `Error: ENOENT ...` under a long stdout), and a head-only cap
// cuts it off. The marker says how much was dropped, so a clipped row is never read as complete.
function clip(s) {
  s = String(s);
  if (s.length <= MAX_STDERR) return s;
  return s.slice(0, HEAD_KEEP) + '\n...[' + (s.length - MAX_STDERR) + ' chars cut]...\n' + s.slice(s.length - (MAX_STDERR - HEAD_KEEP));
}

// The log keeps failed commands and their output for weeks, so credential shapes are masked
// before the write. Narrow on purpose: a near miss (a port, `mkdir -p`, `ssh -p2222`) stays
// readable for /wrap. The `-p<pass>` forms are masked only on mysql/mariadb and docker login,
// case-sensitively (`mysql -P3306` is the port). A credential header is masked to the end of
// its value, so an unknown scheme word cannot shield the secret after it.
const REDACTIONS = [
  [/(:\/\/)[^\s/@]+@/g, '$1[REDACTED]@'],
  [/(\s(?:-u|--user)[= ]?\s*['"]?)[^\s:'"]+:[^\s'"]+/g, '$1[REDACTED]'],
  [/((?:^|\s)--?(?:password|passwd|token|secret|api[_-]?key)[= ]\s*['"]?)[^\s'"]+/gi, '$1[REDACTED]'],
  [/(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^|;&\n]*?\s-p['"]?)[^\s'"]+/g, '$1[REDACTED]'],
  [/(\bdocker\s+login\b[^|;&\n]*?\s-p\s*['"]?)[^\s'"]+/g, '$1[REDACTED]'],
  [/((?:Proxy-)?Authorization|X-Api-Key|Api-Key|X-Auth-Token|Private-Token)(\s*:\s*)[^'"\r\n]+/gi, '$1$2[REDACTED]'],
  [/(\b[\w-]*(?:token|secret|password|passwd|api[_-]?key|(?:access|secret|private)[_-]?key)\s*=\s*['"]?)[^\s&'"]+/gi, '$1[REDACTED]'],
];
function redact(s) {
  if (typeof s !== 'string') return s;
  for (const [re, to] of REDACTIONS) s = s.replace(re, to);
  return s;
}

const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const { tool_name, tool_input, tool_response, session_id, cwd, hook_event_name } = input;

    if (tool_name !== 'Bash' && tool_name !== 'PowerShell') return done();

    const command = tool_input && tool_input.command;
    let exit_code, stderr, kind;

    // Failed commands fire PostToolUseFailure with a top-level `error` string (e.g. "Exit
    // code 5") + `is_interrupt`; tool_response has NO exit_code. Register this hook on
    // PostToolUseFailure only - successes need no logging and a spawn per call is pure cost.
    if (typeof input.error === 'string' || input.tool_error != null) {
      if (input.is_interrupt) return done(); // user abort, not a mistake
      kind = 'tool_failure';
      const m = /exit code (\d+)/i.exec(String(input.error || ''));
      exit_code = input.exit_code != null ? input.exit_code : (m ? Number(m[1]) : undefined);
      stderr = String(input.error || input.tool_error);
    } else if (tool_response && typeof tool_response.exit_code === 'number' && tool_response.exit_code !== 0) {
      // legacy PostToolUse shape, kept as fallback should the schema regain exit_code
      kind = 'nonzero_exit';
      exit_code = tool_response.exit_code;
      stderr = tool_response.stderr || tool_response.text || '';
    } else {
      return done(); // success or unrecognized -> nothing to log
    }

    const entry = {
      ts: new Date().toISOString(),
      event: hook_event_name,
      tool_name,
      kind,
      session_id,
      cwd,
      command: redact(command),
      exit_code,
      stderr: clip(redact(stderr)), // redact first, so a secret on the cut line is never half-kept
    };
    fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
  } catch (_) {
    // Never let a logging hook surface an error to the session.
  }
  done();
});

function done() {
  process.exit(0);
}
