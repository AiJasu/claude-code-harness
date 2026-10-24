# Threat model - <project>

Copy this to the repo root as THREAT_MODEL.md and fill it in. Keep it short and concrete;
it is read by the security-scan agents as the lens for discovery and the filter for severity.
Update it whenever the architecture changes or a real finding is confirmed.

## What this system is
One or two sentences: what it does, who uses it, where it runs.

## Assets (what an attacker would want)
- e.g. user credentials / session tokens
- e.g. the production database
- e.g. an admin panel
- e.g. API keys with billing or rate-limit value

## Entry points (where untrusted input enters)
- e.g. HTTP endpoints under `src/routes/`
- e.g. WebSocket messages
- e.g. user-supplied commands or input
- e.g. files/URLs the app fetches on a user's behalf

## Trust boundaries - what is TRUSTED (this kills false positives)
State explicitly what you treat as trusted, so the scanner doesn't flag it:
- e.g. config files on the server are trusted (operator-controlled)
- e.g. authenticated admin requests are trusted for X but not Y
- e.g. an internal network is trusted; the public internet is not

## Out of scope
- e.g. physical access to the server
- e.g. supply-chain compromise of pinned dependencies

## Known-accepted risks
- e.g. a third-party API key is long-lived and rotated by hand
- (add confirmed findings and their disposition here over time)
