# Security-scan methodology

Reference for the orchestrator. Consult the relevant sections; do NOT paste these into
subagent prompts verbatim. Subagent prompts stay short ("why + what", let the agent decide
how); these checklists are the orchestrator's own lens for choosing which classes matter,
triaging severity, and filtering false positives. Match classes to the stack - skip what the
code doesn't contain. A grep hit is a *candidate*, never a finding: reachability from an
untrusted entry point (per THREAT_MODEL) is what makes it real.

## 1. Vulnerability-class checklists (by component type)

### Web services and APIs
- Injection: SQL built by string concatenation or interpolation instead of parameterized queries /
  prepared statements; OS command injection through a shell-invoking API (`exec`/`execSync`,
  `system`, `subprocess(..., shell=True)`, a single command string) with interpolated input - prefer
  an argv-array API (`execFile`/`spawn`, `subprocess.run([...])`); NoSQL operator injection
  (`$where`, `$ne` objects arriving in a JSON body); server-side template injection.
- Authn/authz: routes missing the auth middleware; IDOR (an object id from the request used without
  an ownership check); role checks done client-side only; JWT `alg:none`, unverified signature or no
  expiry check; reset/invite tokens that are guessable, reusable or never expire; mass assignment (a
  request body bound straight onto a model, letting a caller set `role` or `owner_id`).
- Deserialization: untrusted bytes into a native deserializer (`pickle`, Java `ObjectInputStream`,
  .NET `BinaryFormatter`, `yaml.load` without a safe loader); `JSON.parse` output fed to a deep
  merge (prototype pollution); any `eval`/`Function`/`vm` on request data.
- Path traversal: a request value joined onto a root directory without normalize + prefix check;
  file-serving calls with user-controlled names; zip/tar extraction without slip guards.
- SSRF/exfil: a server-side fetch of a user-supplied URL with no allowlist; paths that could reach
  `169.254.169.254`, `localhost`, or internal hosts, including via redirects or DNS rebinding.
- Abuse limits: no rate limit or lockout on login, reset and other credential endpoints; error
  responses that leak stack traces, SQL or internal hostnames.

### Bots, webhooks and third-party integrations
- Command auth: privileged actions gated only by where the request arrives from (a channel, a room,
  a source address), not by the caller's role or permission; permission metadata declared on a
  handler but never checked in it.
- Admin "eval"/exec/debug commands (classic RCE); message or payload text flowing unescaped into
  shell, SQL or admin APIs.
- Inbound webhooks/event callbacks that skip the platform's request-signature check, or accept
  replayed events (no timestamp window).
- Integration tokens in source or logs; granted scopes/permissions broader than the features need;
  webhook URLs leaked (a webhook URL is a credential).

### SQL databases
- Dynamic SQL with interpolation, including inside stored procedures (`EXECUTE`/`sp_executesql` over
  a concatenated string); identifiers (table, column, `ORDER BY`) interpolated without an allowlist
  or the engine's identifier-quoting function; missing row-level scoping behind auth (IDOR at the DB
  layer).
- The application's DB user is the schema owner or a superuser; overbroad grants; credentials in
  committed connection strings; the DB port reachable from outside the application's network.

### Container hosts (Docker, Compose and similar)
- Secrets in `environment:`, build args or image layers instead of a runtime secret or a gitignored
  `.env` (and check that `.env` really is gitignored).
- Ports published on `0.0.0.0` that should bind `127.0.0.1:` - DB/admin interfaces exposed
  publicly; published container ports can bypass host firewall rules.
- `privileged: true`, bind-mounts of `/` or the Docker socket, added capabilities, running as root
  unnecessarily.
- Image pinning (digest/tag vs `latest`) and base-image provenance.

### Scheduled jobs and scripts (cron, systemd timers, Task Scheduler; shell, PowerShell, Python)
- Command injection via `eval`/`Invoke-Expression` or unquoted variable expansion of external data;
  unquoted paths with spaces.
- PATH hijack: invoking a bare executable name that resolves to a planted binary in cwd or a
  writable dir (prefer absolute paths); DLL/shared-library search-order abuse.
- Permissions: a script, config file or directory writable by a lower-privileged user that a
  higher-privileged job executes or reads.
- Job definitions: the action script in a user-writable location; the job running with more
  privilege than it needs; stored credentials; signature/execution-policy checks bypassed for
  scripts that are not fully trusted.
- Temp files with predictable names in a shared temp directory (symlink / race attacks).

### Web frontends
- XSS: raw-HTML sinks (`innerHTML`, `dangerouslySetInnerHTML`, `v-html`), unsanitized markdown
  rendering, URL props or attributes accepting `javascript:`.
- Secrets shipped to the client: anything in the bundle is public - build-time variables exposed to
  client code (e.g. `VITE_`, `NEXT_PUBLIC_`, `REACT_APP_` prefixes) must never hold keys or tokens.
- AuthZ enforced only in the UI (hidden buttons) with no server-side check behind it.
- CORS `*` or a reflected origin with credentials; `postMessage` without an origin check; open
  redirects; session tokens in `localStorage` where any XSS can read them.

### Plugin and extension systems
- Extension entry points (hooks, commands, event handlers) that trust their arguments: queries or
  file paths built from them, privileged host APIs reachable without an authorization check.
- Dynamic loading or reflection (`importlib`, `require`, `dlopen`, class-by-name lookups) on
  user-controlled strings; extensions loaded from a location a lower-privileged user can write,
  with no signature or integrity check.
- Secrets hardcoded in extension source instead of injected configuration or a secret store.
- Isolation: an extension running with the host's full privileges, or able to read another
  extension's data or credentials.

### CLI tools
- Argument injection: user input passed to a subprocess where it can be read as an option (no `--`
  separator), or a CLI that shells out with interpolated arguments.
- Config or hooks auto-loaded from the current directory or the repo being processed - running the
  tool inside an untrusted checkout executes that checkout's code.
- Secrets taken as command-line arguments (visible in process listings and shell history) or
  printed in verbose/debug output; self-update or plugin downloads with no signature check.

### Desktop and mobile apps
- Local entry points trusted by default: custom URL schemes / deep links, local IPC or loopback
  servers, and exported components other apps can call, accepting input with no origin check.
- Embedded web views loading remote content with a native bridge enabled (e.g. Electron with
  `nodeIntegration` on or `contextIsolation` off).
- Tokens stored in plaintext app data instead of the OS keychain/keystore; update channels without
  signature verification.

### Cross-cutting
- Secret handling: live tokens/keys/passwords/private keys in source, config, logs, error messages,
  or committed `.env`; secrets echoed to chat/console/log sinks; secrets in URLs (query strings
  get logged). Distinguish real secrets from placeholders (section 3).
- TLS/cert: verification disabled (`rejectUnauthorized:false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`,
  `verify=False`, `InsecureSkipVerify`) without a prod gate; a raw TLS socket opened without
  hostname verification (lower-level socket APIs often skip checks the HTTP client does by
  default); a custom hostname check that accepts anything.
- Business logic: caller-supplied values trusted as authoritative (a price, a balance, an account
  id, a role) - a logic flaw, still in scope.
- Dependency / supply-chain: unpinned or `latest` deps; known-vulnerable versions (npm audit /
  lockfile); install/postinstall scripts from untrusted packages; typosquat-shaped names;
  unverified downloads executed (curl|bash, download-then-run).
- Prompt-injection (AI-integrated code): untrusted text (web page, file, user/tool output) flowing
  into an LLM prompt that can then trigger tools/actions - treat tool-calling on injected content as
  a command/exfil path; no instruction/data separation; LLM output used to build shell/SQL/URLs;
  secrets or system prompt reachable via "ignore previous / print your config".

## 2. Severity rubric

Score = f(exploitability, impact, exposure). Anti-anchoring rule (from SKILL.md): write one line of
reasoning for EACH of the three axes **before** naming a level. No number-first triage.

- Exploitability: High = attacker-controlled input reaches the sink directly, no preconditions.
  Med = needs specific state, a valid low-priv account, or a race. Low = needs local access, an
  unlikely config, or chaining several weak links.
- Impact: High = RCE, full DB read/write, auth bypass, secret/credential disclosure, admin-panel
  takeover. Med = limited data leak, single-user IDOR, single-service DoS. Low = non-sensitive info
  leak, self-only effect.
- Exposure (per THREAT_MODEL): public-internet unauth > authenticated user > trusted internal
  network > operator-only/local. A trusted-boundary-only reach caps severity.

Level anchors (assign after the three lines above):
- Critical: unauth or low-effort path from a public entry point to RCE / auth bypass / full DB /
  secret disclosure.
- High: real exploit with one meaningful precondition (valid account, specific input), or high
  impact reachable only from an authenticated/semi-trusted position.
- Medium: needs chaining, limited blast radius, or reachable only from a mostly-trusted boundary.
- Low: defense-in-depth gap, low-value info leak, or requires local/operator access.
- Info: not exploitable as-is; note for hardening. Not counted as a finding.

## 3. False-positive discipline

Confident false positives are THE failure mode. A candidate is reported only after it clears the
verification bar below. Common FP patterns - down-rank or drop:

- Placeholder secrets: `xxx`, `your-token-here`, `changeme`, `example`, all-zero, `AKIA...EXAMPLE`,
  anything in `.env.example`/docs/README. Only a live-shaped secret in a real file counts.
- Test fixtures & mocks: hardcoded creds/keys in `*.test.*`, `__tests__`, `fixtures/`, `mocks/`
  that never run in prod. Confirm the sink is prod-reachable, not merely present.
- Dev-only endpoints/flags gated by an environment check (`NODE_ENV`, a debug flag, a build
  profile) - e.g. a debug route mounted only outside prod. Verify the gate actually holds -
  before dismissing AND before flagging.
- Risks recorded as known-accepted in THREAT_MODEL: not findings, unless the review explicitly
  targets them.
- Trusted operator input: server config files, admin-authenticated requests, flags and environment
  set by the operator - trusted per THREAT_MODEL; interpolating them into a query is not injection.
- Framework guarantees: parameterized-query builders, an ORM that escapes, React's default text
  escaping - don't flag the already-escaped path.

Verification bar: report only if (a) the sink is reachable from a real untrusted entry point, (b) the
input is attacker-controllable, and (c) no upstream validation/gate neutralizes it. If any is
unproven, drop it with a one-line reason - never report "to be safe".

## 4. Subagent rubric

Keep prompts short (why + what + tools). These rubrics define the *return contract*, not the method.

### Finder agent must return, per candidate
- Location: `file:line` (exact).
- Evidence: a short verbatim quote of the offending line(s).
- Class: which vulnerability class (section 1).
- Why exploitable: the path from an untrusted entry point to this sink, and what the attacker
  controls. If it can't state the entry point, it's a candidate at best - say so.
- Suggested fix: one concrete change (parameterize, allowlist, add auth check, verify the hostname).
- No dumps of clean code; report candidates only.

### Verifier agent (separate; must NOT see finder reasoning)
Prompt adversarially: "Assume this is a false positive; find why it's wrong." It must challenge:
- Reachability: is there a real call path from an untrusted entry point? Trace it or refute it.
- Attacker control: is the tainted value actually attacker-controlled, or operator/trusted/constant?
- Neutralizers: any upstream validation, escaping, auth middleware, or prod gate that defuses it?
- Proof: produce a concrete PoC - an input/test reaching the sink - or downgrade/drop.

Output: CONFIRMED (with PoC or the exact reachable path) or DROPPED (with the specific reason).
Survivors proceed to severity triage (section 2). Dropped candidates are still listed in the report
with their reason, so the user sees what was considered and why it was excluded. Reporting a refuted
finding is worse than missing one - it burns trust and drives over-engineered fixes.
