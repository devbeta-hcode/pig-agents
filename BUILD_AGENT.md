# 🚀 BUILD_AGENT.md

## Practical Advanced AI Coding Agent + Web UI

---

# 🎯 GOAL

Build a **real AI coding system** with:

### Backend:

* autonomous coding agent
* file system access
* terminal execution
* LLM integration (OpenAI / local)

### Frontend:

* Based on the layout and functionality of https://github.com/coder/code-server
* file explorer
* terminal
* chat panel (agent control)
* optional editor (Monaco)

---

# 🧠 CORE PRINCIPLE

This is NOT an IDE clone.

This is:

> Thin UI + Powerful Agent Engine

---

# 🏗️ SYSTEM ARCHITECTURE

```text
Frontend (React + Vite)
 ├── File Explorer
 ├── Editor (optional)
 ├── Terminal (xterm.js)
 └── Chat Panel

Backend (Node.js + TypeScript)
 ├── Agent Engine
 ├── LLM Client
 ├── Tool System
 ├── File API
 ├── Terminal (PTY)
 ├── Patch Engine
 └── Validator
```

---

# 📁 PROJECT STRUCTURE

```bash
app/
  backend/
    src/
      agent/
        executor.ts
        planner.ts
        context.ts
        parser.ts

      llm/
        client.ts
        prompt.ts

      tools/
        file.ts
        terminal.ts
        patch.ts
        command.ts

      relevance/
        search.ts

      validation/
        validator.ts

      api/
        routes.ts

      utils/
        logger.ts

      server.ts

  frontend/
    src/
      components/
        FileTree.tsx
        Chat.tsx
        Terminal.tsx
        Editor.tsx
        DiffViewer.tsx

      lib/
        api.ts

      App.tsx
      main.tsx

  .env
  package.json
```

---

# ⚙️ CONFIGURATION (.env)

```env
LLM_PROVIDER=openai

OPENAI_API_KEY=your_key

BASE_URL=http://localhost:11434/v1
MODEL=qwen2.5-coder

MAX_CONTEXT_FILES=5
MAX_ITERATIONS=5
```

---

# 🤖 AGENT ENGINE (IMPORTANT)

Agent must implement:

### 1. Task Loop

```text
1. receive task
2. build context
3. call LLM
4. parse response
5. execute tool
6. validate
7. repeat
```

---

### 2. ReAct Format

```text
THOUGHT:
...

ACTION:
{ "type": "...", "input": "..." }

OR

FINAL:
...
```

---

### 3. Iteration Limit

```text
MAX_ITERATIONS = 5
```

---

# 🔍 RELEVANCE ENGINE

Agent must:

* scan project files
* score relevance based on:

  * keywords
  * filename
  * imports

Select top N files.

---

# 🧩 CONTEXT BUILDER

Context must include:

* relevant files (truncated)
* task
* previous steps

---

# 🧰 TOOL SYSTEM

### Required tools:

* read_file(path)
* list_files(dir)
* search_code(query)
* run_command(cmd)
* write_patch(diff)

---

# 🔧 PATCH ENGINE

Format:

```
SEARCH
old code

REPLACE
new code
```

Rules:

* minimal change only
* do not rewrite entire file

---

# 🧪 VALIDATION

After each change:

* run build/test
* capture output

If fail → retry

---

# 🖥️ TERMINAL SYSTEM

Use:

* frontend: xterm.js
* backend: node-pty

---

### API:

POST /terminal

```json
{
  "cmd": "npm run build"
}
```

---

# 📂 FILE SYSTEM API

### GET /files

Return file tree

---

### GET /file?path=...

Return file content

---

# 💬 AGENT API

### POST /agent/run

```json
{
  "task": "fix login bug"
}
```

Return:

```json
{
  "logs": [],
  "result": "...",
  "diff": "..."
}
```

---

# 🖥️ FRONTEND REQUIREMENTS

Use:

* React
* Vite

---

## FileTree

* recursive tree
* click → open file

---

## Terminal

* real shell via backend

---

## Chat Panel

* input task
* display logs
* display agent result

---

## Editor (optional)

* Monaco Editor
* show file content

---

## Diff Viewer (optional)

* show patch changes
* approve / reject

---

# 🔗 FRONTEND ↔ BACKEND FLOW

```text
User enters task
→ POST /agent/run
→ backend runs agent
→ returns logs + result
→ UI updates chat + diff
```

---

# 🔒 SAFETY

* block dangerous commands
* restrict file paths
* limit execution time

---

# ❗ REQUIREMENTS

* NO mock data
* MUST execute real code
* MUST modify real files
* MUST be runnable locally

---

# 🚀 OPTIONAL (ADVANCED)

* streaming logs (SSE/WebSocket)
* embedding search
* AST patch (ts-morph)

---

# 🔥 FINAL GOAL

System must allow:

* browse files
* run terminal
* ask AI to modify project
* see result immediately

---

This is a **real developer tool**, not a demo.
