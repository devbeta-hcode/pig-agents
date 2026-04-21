# docs/agents/

Deep-dive documentation for AI coding agents working on this repo. The
top-level entry point is [`../../AGENTS.md`](../../AGENTS.md) — start there.
This folder is for when you need details about a specific subsystem.

| File | Read when you need to … |
| --- | --- |
| [`session-handoff.md`](session-handoff.md) | pick up state from the previous chat session |
| [`architecture.md`](architecture.md) | understand the high-level layout, processes, ports, and data stores |
| [`backend.md`](backend.md) | navigate / extend the Express backend |
| [`frontend.md`](frontend.md) | navigate / extend the React UI and its messaging patterns |
| [`agent-loop.md`](agent-loop.md) | change the ReAct prompt, parser, tools, or modes |
| [`api.md`](api.md) | look up an endpoint contract (REST / SSE / WS) |
| [`chat-history.md`](chat-history.md) | touch chat persistence, search, export/import |
| [`workflows.md`](workflows.md) | follow a recipe for a common change |
| [`conventions.md`](conventions.md) | check code style, comment policy, error handling |
| [`troubleshooting.md`](troubleshooting.md) | diagnose a known failure mode |

> Keep these docs short and high-signal. If a doc grows past ~300 lines,
> split it. If two docs say the same thing, delete one and link to the
> survivor.
