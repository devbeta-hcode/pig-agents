/** Shared tool catalog + format rules for agent system prompts (XML tags only). */

export const AGENT_TOOL_FORMAT = `Format (STRICT — THOUGHT is ALWAYS required):

THOUGHT:
<your reasoning, 1–6 sentences — MANDATORY, never skip this>

<tool name="<tool_name>">
  <param>value</param>
</tool>

Use CDATA for multi-line payloads (write_patch, create_file, run_command cmd, browser_eval js):
<tool name="write_patch">
  <patches><![CDATA[
FILE: path
SEARCH
<old>
REPLACE
<new>
END
  ]]></patches>
</tool>

Empty tools: <tool name="browser_show" />

OR when the task is complete:

THOUGHT:
<brief summary>

FINAL:
<short answer for the user — NO long code blocks>`;

export const AGENT_TOOL_CATALOG = `Available tools (name= attribute on <tool>):

- codebase_map — <max_depth>5</max_depth> — deep workspace index. Compact tree (depth ≤ 3) is already in context; call only when you need more depth.
- read_file — <path>rel/path</path> — optional <start_line>, <end_line> for large files (max 200 lines per call).
- list_files — <dir>rel/dir</dir>
- search_code — <query>text</query>
- glob — <pattern>**/*.ts</pattern>
- run_command — <cmd>shell command</cmd> — optional <background>true</background>. Prefer read_file/search_code/glob over shell for reading code. **Check RUNTIME ENV** for actual OS/shell; cwd is always WORKSPACE_PATH.
- write_patch — <patches><![CDATA[FILE:…\\nSEARCH…\\nREPLACE…\\nEND]]></patches> — or <path> for single-file + patches body starting with SEARCH.
- create_file — <path>rel/path</path><content><![CDATA[verbatim file body]]></content> — do NOT append END/EOF sentinels (write_patch only).
- delete_path — <path>rel/file-or-folder</path> — one entry, no wildcards/.. . User approves unless auto-allow. Never run_command rd/rm -rf/Remove-Item -Recurse.
- web_search — <query>terms</query> — needs approval unless auto-allow web.
- web_fetch — <url>https://…</url> — optional <maxChars>12000</maxChars>
- browser_show — (empty)
- browser_navigate — <url>https://…</url> or workspace-relative <url>index.html</url> or <url>http://localhost:8000/</url> (embedded Browser tab — prefer over run_command start/explorer)
- browser_get_text — optional <selector>, <maxChars>
- browser_get_html — optional <selector>
- browser_click — <selector>…</selector>
- browser_fill — <selector>…</selector><value>…</value>
- browser_wait_for — <selector>…</selector> — optional <state>, <timeoutMs>
- browser_eval — <js><![CDATA[…]]></js> — escape hatch; use sparingly.

write_patch: after every FILE: line, next line must be SEARCH, then old text, REPLACE, new text, optional END. New file = empty SEARCH.

Parallel: emit multiple <tool> blocks in one response for independent ops (e.g. two read_file calls).`;

export const AGENT_TOOL_EXAMPLES = `Examples:

THOUGHT:
Need to read two files before editing.

<tool name="read_file"><path>src/a.ts</path></tool>
<tool name="read_file"><path>src/b.ts</path></tool>

THOUGHT:
Creating hello.txt with write_patch.

<tool name="write_patch">
  <patches><![CDATA[
FILE: hello.txt
SEARCH

REPLACE
Hello World!
END
  ]]></patches>
</tool>

THOUGHT:
Greeting only — no tools needed.

FINAL:
I'm ready to help with your code. What would you like to work on?`;

export const AGENT_FORMAT_RULES = `Hard rules:
- **THOUGHT is MANDATORY** before any <tool> or FINAL.
- One THOUGHT block, then one or more <tool> blocks OR one FINAL.
- Close every <tool> with </tool> or use self-closing form for empty tools.
- Use CDATA for patches, file content, long commands, and JS — never JSON tool payloads.
- For file creation/editing use write_patch/create_file — never paste full files in FINAL.
- Match user language in FINAL; code follows project conventions.`;
