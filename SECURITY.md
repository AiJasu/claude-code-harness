# Security

The hooks in this repository run on your machine with your permissions, on every tool call
Claude Code makes. A security bug here could be a guard that fails to stop a dangerous command,
a hook that writes secrets into a log, or a file that runs code you did not expect.

## How to report a problem

Report it privately: open the **Security** tab of this repository and choose
**Report a vulnerability**. Please do not open a public issue for a security problem.

Include what you ran, what happened and what you expected. A short command or hook input that
reproduces it helps most.

## What is covered

- The hooks, tools and skills in this repository, and the install steps in the README.
- Not covered: Claude Code itself (report those to Anthropic through its own disclosure
  program) and changes made in your own copy.

Only the latest commit on `main` gets fixes; there are no release branches.
