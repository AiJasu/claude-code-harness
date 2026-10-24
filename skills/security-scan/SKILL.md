---
name: security-scan
description: Threat-model-driven security review of a codebase or diff - find vulnerabilities, then verify each one with an independent agent before reporting. Use when asked to security-review, audit for vulnerabilities, check for injection/auth/secret issues, or harden code. Distinct from the always-on secret-write guard; this is an on-demand deep review.
---

# Security scan

A security review that biases hard toward **precision**: the failure mode of LLM security
review is confident false positives, so discovery and verification are deliberately split,
and a finding is only reported if a fresh agent that never saw the discovery reasoning can
independently confirm it (ideally with a proof of concept). Based on Anthropic's "Using LLMs
to secure source code".

Scope to review: $ARGUMENTS  (a diff, a directory, or "the whole repo" - default to the
current diff if there is one, else ask).

## Procedure

1. **Threat model first.** If `THREAT_MODEL.md` exists at the repo root, read it and use it
   as the lens. If not, offer to create one from `assets/THREAT_MODEL.template.md` (copy it,
   fill in trust boundaries, assets, and what is explicitly *trusted* - this is what kills
   false positives). Bootstrap it from architecture docs, git history, and past issues.

2. **Discovery.** Spawn one or more subagents to hunt. Every Agent call MUST pass an explicit
   `model` (the routing hook blocks it otherwise): `sonnet` for discovery sweeps, `opus` for
   the verification agents in step 3. Give them tools (Grep, Glob, Read,
   and any SAST/linters present) and a *simple* prompt stating the "why" and "what", not a
   prescriptive checklist - let the agent decide "how". Focus on classes that fit the stack
   (e.g. injection, auth/authz bypass, SSRF, deserialization, secrets-in-source, path
   traversal, unsafe `eval`/shell). Collect candidate findings with file:line.

3. **Independent verification (the important step).** For EACH candidate, spawn a *separate*
   subagent that does NOT see the discovery reasoning. Prompt it adversarially: *"Assume this
   is a false positive. Find the reasons it is wrong."* Require it to either produce a
   concrete proof of concept (a failing test or exploit input that reaches the sink) or
   downgrade the finding. Non-reproducible findings get dropped, not reported.

4. **Severity triage.** For survivors, rate by preconditions - reachability, attacker
   control of the input, authentication required, and blast radius - calibrated against the
   threat model. Have the agent write the reasoning for each criterion *before* assigning a
   score (prevents anchoring).

5. **Report.** For each confirmed finding: file:line, the vulnerability class, the PoC or the
   exact reachable path, severity with its reasoning, and a concrete fix. Separate confirmed
   from dropped (and say why each was dropped). Do not pad the list.

6. **Patch (only if asked).** Test-driven: write a failing test that reproduces the issue,
   then fix, then confirm the test passes. After fixing a root cause, grep for the same
   pattern elsewhere (variant analysis). Finish with a fresh discovery agent against the
   patched code to confirm closure. Gate completion on that fresh discovery agent coming back
   clean, not on "looks fixed".

For the detailed prompts, agent rubrics, and vulnerability-class checklists, see
`references/methodology.md` - read it when you need the depth, not before.

## Notes
- This is review-only by default; it does not modify code unless the user asks for patches.
- For many independent findings, a dynamic workflow (fan-out discovery -> adversarial verify
  per finding) is the efficient shape.
