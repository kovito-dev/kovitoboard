# Claude Code 2.1.104 Trust Prompt Fixtures

This directory is reserved for tmux capture-pane fixtures from Claude Code
**2.1.104** (the `@stable` dist-tag as of v0.1.0). Fixtures must be captured
on a real Claude Code installation and have all personal information masked
per DEC-012 (no real paths, usernames, or email addresses).

## How to create fixtures

```bash
# Install Claude Code 2.1.104
npm install -g @anthropic-ai/claude-code@2.1.104

# Capture the pane after the trust prompt appears
tmux capture-pane -t <target> -p -S -100 > folder-trust-initial-01.txt
```

Replace personal paths (`/home/<username>/…`) with `/home/user/…` before
committing.

## Status

Placeholder directory created during R3-6 implementation. Actual fixtures
to be captured during manual regression testing (R3-8).
