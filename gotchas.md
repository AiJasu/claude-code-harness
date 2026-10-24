# Learned environment gotchas

Durable CROSS-CUTTING rules distilled from real mistakes. Maintained by `/wrap`: it reads
`bash-errors.jsonl`, keeps only genuine wrong-then-fixed cases, and routes each rule to the right
home - project-scoped rules to THAT PROJECT's CLAUDE.md, only machine-wide rules here. FORMAT IS
THE POINT: one entry = the correct way + the wrong way it replaces, 1-3 lines, no incident
narrative. This file is imported into every session, so keep it short: a /wrap that adds a rule
retires one that stopped being true.

## Windows / shell
- Bash tool = Git Bash, NOT PowerShell: `2>/dev/null` (not `2>$null`); Windows checks (`Test-Path`,
  `Get-Command`) go through the PowerShell tool. Bash-tool cwd PERSISTS across calls, even into a
  PARALLEL sibling: lead with `cd /c/path/to/<proj> &&`, hop as `(cd sub && ...)`.
  Multi-line commit messages: Write tool -> `msg.txt`, then `git commit -F msg.txt` (SAME literal
  path); never `-m @'...'@` (PS here-string: `pathspec '<word>' did not match`, exit 127) nor a
  printf-redirect + commit in one call (exit 128).
- `pwsh -File s.ps1 -Param a,b,c` binds ONE string; use `pwsh -Command "& s.ps1 -Param 'a','b','c'"`.
  Splatting `@array` into a NATIVE exe joins any element containing `=`/`,` with the next arg -
  pass native-exe args explicitly.
- Nested-shell quoting (paths, `$vars`, `\"`, backticks, `\uXXXX`, REGEX literals) is a losing fight:
  bare `/c/x` args to native exes get MSYS-mangled (rg REGEX args too: `\bC:/`, `^// `), a
  double-quoted outer string eats inner `$vars` and a regex's backslashes (`node -e`: "Invalid
  regular expression: missing /"), a backtick opens command substitution, `node -e` can't emit `\u`
  escapes. Two shells deep = Write the script to a FILE, run `node file.js` / `pwsh -File`. Use
  `C:/x` paths or `MSYS_NO_PATHCONV=1` (a native tool reading bash's `/tmp` file needs the Windows
  path). A mangled path fails UNSAFELY: `/c/x` reaches node as `C:\c\x`, so a guarded `if (exists)`
  loop prints a clean ZERO instead of throwing.
- Heredocs are unsafe for scripts (a long body can die mid-write; quoted heredocs halve `\\`; the
  guard warns), and non-ASCII does NOT arrive intact through them OR the Edit tool (a heredoc'd
  str-replace silently no-ops; an Edit pair differing only in a non-ASCII char reads "No changes
  to make"). Scripts with a backslash, non-ASCII or over a few lines go through the Write tool;
  build special chars from codepoints (`String.fromCharCode(0x2014)`; a `\uXXXX` in an Edit/Write
  parameter ARRIVES DECODED) and re-read the target. A full Write re-emits a literal already in the
  file: restructure the CODE not to need it (`/^[^{]+/` strips a BOM); grep `[^\x00-\x7F]` to confirm.
- Python stdout is cp1252 under Git Bash: `PYTHONIOENCODING=utf-8` or parse in node. No `bc`:
  `$(... | bc)` is EMPTY silently - float math via `awk 'BEGIN{print ...}'` or node. A syntax
  check is `python -c "import ast; ast.parse(open(f).read())"` or `PYTHONDONTWRITEBYTECODE=1`,
  never `py_compile`/a bare import: they drop `__pycache__` into a skill or hook folder.
- Windows paths in Bash: SINGLE-quote them or write `/c/...`. Unquoted, bash eats every backslash
  (`cd C:\Users\you\x`: `cd: C:Usersyoux: No such file or directory`); double-quoted, a
  trailing `"C:\dir\"` escapes the quote (`unexpected EOF while looking for matching '"'`).
  `tar` reads `C:/x.tgz` as host `C` (`Cannot connect to C: resolve failed`, exit 128): `/c/x.tgz`
  or `--force-local`.
- Git Bash `echo` eats backslash escapes even inside SINGLE quotes (`echo '{"cwd":"C:\\x"}'` emits
  `C:\x`, invalid JSON): feed hook/JSON payloads with `printf '%s'`. It fails UNSAFELY: a fail-open
  hook falls back to `process.cwd()` and PASSes the case you meant to test.
- A command PRINTED FOR THE USER to run runs in Git Bash too (the `!` prefix): write
  `./build/app.exe`, never `.\build\app.exe` (bash: `buildapp.exe: command not found`). Docs
  spell run commands in PowerShell form: convert the slashes, never paste verbatim.
- `$TMPDIR` is EMPTY in Git Bash, and so is ANY `$VAR` set in an earlier call (shell state does not
  persist): `> "$TMPDIR/x"` writes `/x` = `C:/Program Files/Git/x` and exits 0 (an `||` fallback
  never fires). Redirect to the scratchpad or a var the same command sets, or let `run_in_background`
  name the log. A PowerShell `Start-Job` dies with its tool call too (`Receive-Job -Name x`: "job not
  found"): `run_in_background` instead.
- Git Bash grep fails UNSAFELY, always reading as a clean zero: the perl-regex flag dies "unibyte
  and UTF-8 locales" (guard blocks it); `$'[^\x00-\x7F]'` patterns fail on embedded NUL; pattern-
  FILE greps (`-Ef/-Ff`) and `-r` with several `-e` core-dump (exit 134); a multi-term grep loop returns
  0 for EVERY term and drops `grep.exe.stackdump` in cwd. Use the Grep tool, `rg` or node (non-ASCII:
  `[^\x00-\x7F]`; diffs: `git diff -U0 | grep '^+' | rg -c`).
- A command piped to `tail`/`head`/`grep` reports the PIPE's exit code and discards the failure
  (`npm test | tail` = exit 0 on 3 failures): redirect to a file + `echo $?`, or `${PIPESTATUS[0]}`.
  Never pipe a script that WRITES files into `head` - EPIPE kills it mid-write. PowerShell
  `| Select-Object -First N` STOPS the native command (one that already acted dies on its success
  print, reading as a refusal): `$o = cmd`, filter `$o` only after `$LASTEXITCODE` is 0, never
  `| Select-String` over `2>&1` (drops the exception line).
- `core.autocrlf=true`: files without `eol=lf` are CRLF on disk though LF in the index, so
  `\n`-anchored `node -e` replaces miss and `grep $'\r$'` reports 0. Check `git ls-files --eol`;
  anchored multi-line edits via the Edit tool or normalize CRLF first.

## PowerShell language traps
- A STATEMENT or `;`-sequence in `( )` is a parse error ("Missing closing ')'"); `$( )` is the form:
  `$(try {...} catch {...})` as a hashtable value, `$(cmd; $LASTEXITCODE -eq 0)` for a native
  command plus its exit test. A `foreach (...) {...}` STATEMENT cannot feed a pipe ("An empty pipe
  element is not allowed"): `$(foreach ...) | Select` or `ForEach-Object`. `"$n: x"` parses `:` as a
  scope qualifier - write `"${n}: x"`. `-replace $pat, $a + $b` is a parse error - write `($a + $b)`.
  A command as a method argument needs its own parens (`$l.Add((Get-X $p))`). Exact-content writes:
  `[System.IO.File]::WriteAllText` (`Set-Content -NoNewline` was missing).
- `Select-String` is case-INSENSITIVE by default (`Loaded` matches `Unloaded`): `-CaseSensitive`.
  `R`/`r` is the `Invoke-History` alias - a helper named `R` resolves to it; name helpers `Chk` etc.
- Variable names are case-insensitive: `foreach ($r in ...)` silently shadows an outer `$R`, later
  `$R['key']` = `$null`. Descriptive names, never a one-letter pair; `$script:X` for accumulators;
  emit an input count so "found nothing" differs from "was handed nothing". Never name a parameter
  `$Args` (the automatic unbound-args variable): `@Args` splats EMPTY and the native command runs
  bare (exit 0, read as a pass).
- `$LASTEXITCODE` is NOT reset by a command that fails to launch: a missing exe leaves the previous
  step's code in place, so `& $exe` after a passing step reads as PASS for a check that never ran.
  `Get-Command $exe` first, or `$global:LASTEXITCODE = $null` before the call and treat null as fail.
  A GUI-subsystem exe is not waited for (`$LASTEXITCODE` EMPTY): `Start-Process -Wait -PassThru`,
  read `.ExitCode`.
- A wrapper that runs a launcher script (one that spawns hidden daemons) waits with `$p = Start-Process
  ... -PassThru; $p.WaitForExit()`: `& pwsh -File launcher.ps1 | Out-Null` hangs because the daemons
  inherit the child's stdout pipe (no EOF), and `Start-Process -Wait` hangs because it waits for the
  descendants too. Both look like a dead launcher while the services are already up.

## Guard hook (~/.claude/hooks/guard-hook.js)
- A removal verb (`Remove-Item`/`rm`/`del`/`rd`, PS delete aliases) goes in its OWN call with a
  LITERAL path: the always-on scanner (every mode, sandbox flag does not lift it) blocks it beside a
  `$var`, a bare `*` or `/`, a short root like `/c`, a quoted spaced path, or regex tokens - spaced
  paths via `$p = Join-Path ...; Remove-Item -LiteralPath $p`. Full trigger list: guard-hook.js.
- Config edits are deliberately NOT guarded. ALWAYS-ON in every mode: secret-WRITE scan,
  catastrophic-command block (rm -rf of the root, a home dir, a drive or a bare `$VAR`,
  `reset --hard` with NO benign exception - use `git merge master --ff-only`, force-push,
  mkfs/dd/shred/format), secret-exfil block (credential path AND network verb in ONE command; a
  URL path counts - probe with `/..%c0%afxyzzy`).
  `/guard-off` suspends catastrophic/exfil + /careful + /freeze for the session; SessionStart re-arms.
- Change or test the guard through its fixture harness (`hooks/tests/guard-hook-fixtures.js`).
  Never put a real `rm -rf /` or a secret string on a command line to test it.
- The settings.json `Read(...)` deny list binds the file tools, not the shell: `Bash(*)` let a
  `cat ~/.ssh/id_ed25519` pass (auto strips that allow). The shell bypasses the Read denies; the
  guard's secret-exfil block is the backstop, so never read a key file through the shell.
- Guard flags "hardcoded secret assignment" on Edit/Write whose NEW text has `token = ...` shapes:
  rename the local or keep the token-ish line only in old_string. A block on a GENERATED test key,
  a `*.env` fixture or a comment is a FALSE POSITIVE: report it under `Need from you:` with the
  loosening you suggest (isPlaceholderValue / the path test); never split the identifier to slip
  past, nor hide that.

## Claude Code harness
- A Workflow subagent's Bash call can wedge with NO tool_result and NO timeout (a shell grep piped
  into `head` is the known trigger): diagnose, remove the trigger and relaunch.
- Validate a workflow with `node ~/.claude/tools/check-wf.js <file.js>`, never `node --check`
  (it rejects the top-level `return` a workflow body may use). It also catches the calls that THROW
  there - `Date.now(`/`Math.random(`/argless `new Date()` - and the undefined `process`/`require`:
  pass timestamps and paths through `args`, vary prompts by index. An INLINE script picks up HTML
  entities (`&lt;`, `&amp;&amp;`) and a prompt backtick ends the template literal: over ~5KB, Write
  it, check it, launch by `scriptPath`.
- Workflow `args` may arrive as a JSON STRING: `const items = typeof args === 'string' ?
  JSON.parse(args) : args`. Keep args to ~2 KB of ids/counts, bulk in a file the agents Read, never
  a ~10 KB args object. Loop workflows dedupe against ALL findings ever seen, not just confirmed.
- Workflow `name:` launch can serve a STALE cached script - after editing, launch via `scriptPath:`
  or grep the persisted snapshot (`workflows/scripts/<name>-wf_*.js`) first. A script in
  `~/.claude/workflows/` SHADOWS the built-in skill's workflow of the same name in every project
  (a fork, no upstream updates).
- A task/Workflow `.output` file wraps the return in `{summary,agentCount,logs,result}`: read with
  `fs.readFileSync` + `JSON.parse` then `.result` (`require()` on a non-.json path throws); it exists
  EMPTY from launch, so a done-watcher tests `[ -s file ]`, never `[ -f file ]`. SELECT the keys you
  need: a whole Read over ~100KB dies on the 25K-token cap, re-charged as cache-read every later
  turn. The RETURN is inlined into the completion notification, cut mid-token past ~8 KB: return
  headline/counts/path, Write the detail (the wf-concurrency hook notes an oversized result).
- WebSearch is capped at 200 calls PER SESSION (`CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`; per TURN in
  `claude -p`), refilled ~100/hour interactive (`CLAUDE_CODE_WEB_SEARCH_REFILLS_PER_HOUR`, 0 headless),
  one pool for all subagents and workflow agents: budget searches per lens ("at most 12, then fetch") or
  raise the env var - never meet the cap as "Web search was not performed".
- Never wait with a foreground sleep on a background Workflow: its completion notification
  re-invokes the turn anyway. Bare `sleep N; echo` (Bash-blocked), `Start-Sleep`, `sleep N && cmd`
  and a sleep inside an ssh payload are the same mistake - poll the real condition from a Monitor
  until-loop, or do other work. Arm a Monitor on a workflow's TERMINAL condition or phase
  transitions, never per-agent records (each event wakes a full-context turn); nothing else to do =
  run it foreground. CHECKED by `hooks/poll-guard.js` (warn-only note on a third read of a task's
  output within 10 min).
- Never hand a producer agent's artifact to a consumer in the SAME parallel batch: await the
  producer and pass the content in, or have it write `<name>.done` LAST for the consumer to assert.
  An agent killed by API 529 leaves its Workflow "completed" with `null` for that stage (only `.logs`
  says `failed:`): a re-run, never a pass - `resumeFromRunId` replays finished agents from cache; if
  529 repeats on the same tier, use another model or the main loop, no auto-retry.
- Tell agents the SHAPE of a JSON artifact you hand them ("an ARRAY of objects, find yours by
  `.id`"), plus the PATH and INPUT FORMAT of any shared script; where the prompt does not say,
  `head -c 300 <file>` before indexing, never guess its keys.
- Edit/Write need an IN-SESSION Read first (system-prompt/memory/pre-compaction does not count),
  and a Read from before a fan-out is stale: grep the anchor again. Never build `old_string` from
  TRUNCATED output (`substr`/`.slice`, `head -c`) - it fails "not found" on a line you can see.
- Parallel sessions: another /wrap can archive `bash-errors.jsonl` between your read and rename -
  guard with `[ -f x ] && mv ...`. Read it filtered to your OWN session_id across live AND archived
  files, archive only your own lines; a missing live file = someone else archived it, not zero
  errors. Foreground Bash git reads can hang to timeout (exit 143) while a background push runs -
  PowerShell git or wait for the task. A live sibling session can rewrite a shared `~/.claude` file
  (a hook, CLAUDE.md, a handoff doc) mid-task: on "File has been modified since read", re-Read and
  layer your change on THEIRS, never restore your copy; append a dated section, never overwrite.
- BROWSER TOOLS exist only if the Chrome integration was ON at session start (`claude --chrome` or the
  `~/.claude.json` flag), interactive only: never in a background job, `/chrome` mid-session arms only
  the NEXT one, flag off = ToolSearch "mcp__" EMPTY. "Extension is not connected": ONE `Need from
  you:` line - Chrome closed: the user opens Chrome; Chrome running: the user types `/chrome` and
  picks "Reconnect extension". Never start the user's browser yourself.
- Audit/verify subagents WILL hit live prod if reachable (they replay payloads to "confirm" findings):
  source-only scope or warn the user, and say which probes are yours.
- A check inherits its environment's defaults: a local server sends none of prod's response headers
  (security/cache headers), Playwright pins prefers-reduced-motion and color scheme, headless Chrome
  clamps the viewport. Name the environment and one failure class it cannot see before writing
  "verified"; never cite a check whose output you did not read. A helper querying a time-dependent
  API computes its date at runtime AND prints it - a hardcoded date rots silently.
- A scratch script that outlives its session is not scratch: the second time you run one (or hand
  its path to an agent) move it into the repo - Temp scratchpads are deletable at any time.
- An auto-mode classifier denial is a SEMANTIC verdict: never re-send it via a sibling tool, variant
  or later turn, nor record a workaround. Report the exact command + target under `Need from you:`
  (the user's explicit go clears a soft block, never a hard deny); a genuinely different, safe
  approach to the goal is fine, the same action reshaped is not. 3 in a row ABORT a no-prompt agent
  (null stage).
- Worktree sessions carry their own rule set - Bash-tool bans inside one, sibling-worktree paths
  refused even read-only, landing, fan-out pin inheritance, files a dead worktree took or ANOTHER
  session's worktree removal deleted (recover from the ref, not the filesystem). The
  `worktree-brief` hook injects it when a session starts in or enters a worktree: read it first.

## Node / Playwright
- Count regex occurrences with a GLOBAL regex (non-global + groups makes `.match().length` count
  groups). `String.replace(str, r)` interprets `$'`/`$&`/`$1` in the REPLACEMENT - a bash `$'...'`
  literal splices the rest of the file in. Use `s.replace(a, () => r)` or `split(a).join(r)`.
- A "sandboxed" test of a repo script must redirect EVERY absolute path the script writes, not just
  its network calls; a `--fix`/rewrite pass over a workspace must exclude the tool's own source and
  regex files.
- `JSON.parse` on a BOM'd file throws a message that ECHOES the input's first ~100 chars, secrets
  included. Secret-bearing configs (`.env`, service JSON, any file holding API keys): strip
  `/^[^{]+/`, parse in try/catch that prints only `e.message.length` (never a bare `node -e` parse),
  redact `key|token|secret` fields before any log, and no `| cut`/`head` on the command (hides the
  exit).
- NEVER screenshot a desktop app with `Graphics.CopyFromScreen`, even cropped to the window's own
  rectangle (UI Automation `BoundingRectangle`): it copies whatever is in front, so a covered
  window yields another window's content. Use the app's own capture API or DevTools, or leave the
  look-at-it check to the user.
