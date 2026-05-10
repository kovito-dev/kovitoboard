# 11. KovitoBoard Process Lifecycle

**Target KB version:** v0.2.0
**Last updated:** 2026-05-10
**Authoritative:** This chapter is authored in English here (no parallel Japanese chapter under `docs/agent-ref/`). Agents and contributors should rely on this chapter as the public-facing source of truth for starting, stopping, and recovering KB.

> 📖 **When to read this chapter:** Whenever a user asks an agent to "start KovitoBoard", "stop KovitoBoard", "restart KovitoBoard", or when an agent encounters a multi-launch error, a stale PID file, or any KB-related process question. KovitoBoard agents that live inside KB itself (Kovito Concierge / Kovito Developer / Secretary) must read §5 before considering any process action.

---

## Purpose

KovitoBoard's start / stop story is intentionally narrow: every supported entry point goes through `tools/kb-start.mjs` (the supervisor) and `tools/kb-stop.mjs` (the cleaner). This chapter defines the protocols all three agent audiences must follow:

- KB users invoking the CLI directly.
- Claude Code agents living in the user's project, asked to launch / stop the embedded KB.
- KB-internal agents living *inside* a running KB session (must NOT stop themselves).

If an agent's instinct is to call `pkill`, `tmux kill-server`, `kill -9`, or `npm run dev`, that instinct is wrong — read the rest of this chapter first.

---

## §1 The two official commands

```bash
# Start KovitoBoard (embedded model)
cd <project>/kovitoboard
npm start -- --project-root ..
```

```bash
# Stop KovitoBoard
cd <project>/kovitoboard
npm run kb:stop
```

That is the entire user-facing surface area for normal operation.

`npm run dev` exists, but it is **for KB contributors only**. It bypasses the supervisor, so `npm run kb:stop` cannot find or stop it. Agents must never recommend or invoke `npm run dev` when fulfilling a user request.

---

## §2 Starting KB (agent protocol)

When a user asks an agent to "start KovitoBoard / KB", do this:

1. `pwd` and confirm you are sitting at the user's project directory (the parent of `kovitoboard/`).
2. Verify `<project>/kovitoboard/package.json` exists. If it does not, tell the user "I cannot find a `kovitoboard/` subdirectory in this project" and stop.
3. Check `<project>/kovitoboard/.kovitoboard/run/supervisor.pid`:
   - File present + pid alive (`kill -0 <pid>` succeeds) → KB is already running. Tell the user "KovitoBoard is already running (pid=N)" and read the `ports.vite` field of the PID file to give them the URL `http://localhost:<port>`. Do **not** start a second supervisor.
   - File present + pid dead (ESRCH) → stale PID file, harmless; continue.
   - File absent → continue.
4. Run **exactly** this command:
   ```bash
   cd <project>/kovitoboard && npm start -- --project-root ..
   ```
5. Watch the supervisor output. Once you see `[kb-start] Frontend: http://localhost:<port>`, hand the URL back to the user.

### Never do these when starting

- Do not run `npm run dev` (contributor-only, bypasses the supervisor).
- Do not run from inside the KB clone without `--project-root` — the supervisor will refuse with an explicit error message and exit code 1.
- Do not start KB from a directory that is not `<project>/kovitoboard/`.
- Do not edit `<project>/kovitoboard/.kovitoboard/run/supervisor.pid` by hand.

---

## §3 Stopping KB (agent protocol)

When a user asks an agent to "stop KovitoBoard / KB", do this:

1. Verify `<project>/kovitoboard/package.json` exists.
2. Run **exactly** this command:
   ```bash
   cd <project>/kovitoboard && npm run kb:stop
   ```
3. Read the exit code:
   - **0** → done; tell the user KovitoBoard stopped cleanly.
   - **3** → graceful shutdown timed out. Ask the user "May I retry with `--force`?" and, on confirmation, run `npm run kb:stop -- --force`.
   - **4** → partial success: the supervisor stopped, but residual processes were detected (printed to stderr by `kb-stop`). Show the user the residue list and ask whether to escalate to `--force`.
   - **2** → permission denied (probably owned by another user). Report and stop; do not retry under elevated privileges without an explicit request.
4. Never default to `pkill`, `kill -9`, `tmux kill-server`, or `pkill -f kb-start`. The official `kb:stop` command exits with the codes above for a reason — its diagnostic output already tells you and the user what to do next.

### Never do these when stopping

- Do not run `kill <pid>` directly using the PID file unless `kb:stop` itself failed.
- Do not run `tmux kill-server` — it would kill every tmux session on the host, including ones unrelated to KovitoBoard.
- Do not delete `<project>/kovitoboard/.kovitoboard/run/supervisor.pid` by hand to "force" a restart; that drops the multi-launch guard and the host has zero record of what was running.

---

## §4 Multi-launch errors and stale PID files

If `npm start` exits with `[kb-start] ERROR: KovitoBoard supervisor is already running (pid=N)`:

1. Read `<project>/kovitoboard/.kovitoboard/run/supervisor.pid`. The JSON contains `ports.vite`; the URL is `http://localhost:<vite-port>`.
2. If the user wanted to **reach** the running KB, give them the URL.
3. If the user wanted to **restart** KB, run §3 (`npm run kb:stop`) then §2 (`npm start -- --project-root ..`).

If `kb-start` reports `WARN: stale PID file detected`, this is informational — the previous supervisor died without cleanup, and `kb-start` already overwrote the file. No agent action required.

---

## §5 Agents living *inside* KB must not stop KB

If your agent definition is one of:

- Kovito Concierge (Kobi)
- Kovito Developer
- Secretary
- Any other agent whose tmux session lives inside a `kovitoboard-<projectDir>` session

…then you must **never** invoke any of the following:

- `npm run kb:stop`
- `tmux kill-server`
- `tmux kill-session` against your own session
- `kill <supervisor-pid>` / `kill -9 <supervisor-pid>`
- Any command that would terminate the supervisor that is hosting you

Stopping KB stops your tmux window. Even if `kb-stop` has a self-suicide guard (it does — see the `--force` notes below), there is no scenario in which an in-KB agent legitimately needs to stop KB. If a user asks you to "restart KovitoBoard from inside KB", reply: "I cannot restart KovitoBoard from inside this session. Please open a terminal outside KovitoBoard and run `npm run kb:stop` followed by `npm start -- --project-root ..`."

This rule is the same family as `agent-ref/10-upgrade.md` §7.4 ("KB self-restart is forbidden"). Both protect against the situation where the agent kills the very process running it, leaving the user with no path back.

For defense in depth, `kb-stop.mjs` itself refuses to kill the tmux session it is currently running inside (it warns and skips that session). The agent-side rule above is the primary line of defense.

---

## §6 What `kb-stop` does and does not do

`kb-stop` performs, in order:

1. Reads the PID file. If absent (or `--all` is set), falls back to `pgrep -f tools/kb-start.mjs`.
2. Sends `SIGTERM` to each supervisor pid found.
3. Waits up to 5 seconds for the PID file to disappear (the supervisor's shutdown handler removes it as the publicly-visible "shutting down" signal).
4. With `--force` and a timeout, escalates to `SIGKILL`.
5. Kills the tmux session recorded in the PID file (`tmux.sessionName`). With `--all` plus `KB_FORCE_TMUX_PREFIX_KILL=1`, also kills any remaining `tmux ls` session whose name starts with `kovitoboard-`.
6. Reports residual `tsx watch`, `vite`, and `claude` processes. Without `--force`, these are reported but **not** killed; the operator decides.

`kb-stop` does **not**:

- Touch processes outside the project root by default (the prefix-wide tmux kill is opt-in).
- Affect any tmux session it is itself running inside (self-suicide guard, see §5).
- Restart anything — that is `kb-start`'s job.

---

## §7 Common questions

**"How do I restart KB?"**
→ `npm run kb:stop` followed by `npm start -- --project-root ..`. There is no single "restart" command on purpose; the two-step form keeps the multi-launch guard honest.

**"Can I just `kill` the supervisor pid?"**
→ Possible, but it skips the tmux cleanup, the residual diagnostic, and the deterministic exit codes. Use `kb:stop` first and fall back to a manual `kill` only when `kb:stop` itself is broken.

**"My CI script wants a non-interactive stop."**
→ `npm run kb:stop -- --force` is safe in non-interactive contexts; it returns 0 / 3 / 4 deterministically and never blocks on input.

**"I see two `kovitoboard-...` tmux sessions on my machine."**
→ Either you have two KB clones running for two different projects (expected, embedded model), or one supervisor died and left an orphan tmux session. `npm run kb:stop -- --all` (with `KB_FORCE_TMUX_PREFIX_KILL=1`) will sweep them, but only do this if you understand both sessions belong to KovitoBoard.

**"The startup banner says `(cwd fallback)` next to the project path."**
→ `kb-start` could not find `--project-root` or `KOVITOBOARD_PROJECT_ROOT`, and the cwd happens to live outside the KB clone. KB will run, but the project root might not be the one you intended. Stop with `kb:stop` and restart with the explicit `--project-root`.
