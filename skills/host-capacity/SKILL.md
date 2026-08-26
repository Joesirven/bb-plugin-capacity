---
name: host-capacity
description: Check whether this bb host can take more agent work before spawning threads, subagents, or workflows, and queue the work instead of spawning it when the host is loaded. Use whenever a task involves starting background agents, fanning out parallel work, running a workflow, or when a thread reports that the host is near capacity.
---

# Working within this host's agent capacity

Every agent thread on this host is a provider bridge worker plus a provider
command-line process. Enough of them at once starve the bb server's event loop
and exhaust memory, which shows up as a slow or unresponsive bb rather than as
a clean failure. This host counts agents against a limit and holds work back
when it cannot take more.

## Before starting background agent work

Call `capacity_check`, or run `bb capacity status`. It reports the level
(`ok`, `warn`, or `critical`), how many agent slots are free, and how many
agents are already waiting in the queue.

- `ok` — start the work normally.
- `warn` — prefer sequential work. If the work must run in the background,
  queue it rather than spawning it.
- `critical` — do not spawn anything. Queue it.

## Queueing instead of spawning

Use the `capacity_queue_agent` tool, or the command line:

```sh
bb capacity spawn --project proj_xxx --prompt "the work" --title "short title"
```

Either path starts the thread immediately when there is room and otherwise
holds it in line, releasing it automatically as capacity returns. Both report
the queue identifier, which cancels the work before it starts:

```sh
bb capacity cancel cap_xxxxxxxx
```

Higher `--priority` numbers leave the queue first. `--hidden` starts the thread
as a background worker rather than a visible one.

## Reading what happened

```sh
bb capacity queue --all      # queued work and how recent work settled
bb capacity warnings         # overload warnings, newest first
bb capacity history          # recent capacity samples
bb capacity shed             # threads enforcement stopped on a critical host
```

## What this does not do

Holding work back is advisory on the paths that opt into it. A thread started
straight from the bb interface, from `bb thread spawn`, or by a provider's own
subagent mechanism does not pass through this queue. bb's thread lifecycle
events are observe-only, so no plugin can refuse a thread start. When
enforcement is configured beyond warning-only, a thread that starts anyway on a
critical host is stopped after the fact and listed under `bb capacity shed`;
stopping loses the turn in progress, so prefer the queue.
