import { useEffect, useRef, useState, useMemo } from "react";
import { Button, ConfigProvider, Input, InputNumber, Select, Slider, theme } from "antd";
import { api, type SettingsPayload } from "../lib/api";
import { pig } from "../lib/pig.js";
import { Modal } from "./Modal";
import { IconCheck, IconChevronDown } from "./Icons";

const FALLBACK_PROVIDER_OPTIONS = [
  { value: "chatgpt", label: "ChatGPT (OpenAI)" },
  { value: "gemini", label: "Gemini (Google)" },
  { value: "claude", label: "Claude (Anthropic)" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "mistral", label: "Mistral AI" },
  { value: "xai", label: "xAI (Grok)" },
  { value: "moonshot", label: "Moonshot (Kimi)" },
  { value: "qwen", label: "Qwen (DashScope)" },
  { value: "groq", label: "Groq" },
  { value: "together", label: "Together AI" },
  { value: "fireworks", label: "Fireworks AI" },
  { value: "cohere", label: "Cohere" },
  { value: "perplexity", label: "Perplexity" },
  { value: "openroute", label: "OpenRouter" },
  { value: "cursor", label: "Cursor (Cloud Agents API)" },
  { value: "ollama", label: "Ollama" },
  { value: "local", label: "OpenAI-compatible (local)" },
] as const;

function isOpenAiShapedProvider(p: string): boolean {
  return p !== "ollama";
}

const PROMPT_MODE_OPTIONS = [
  { value: "minimal", label: "Ultra-frugal (fewest tokens)" },
  { value: "economical", label: "Economical" },
  { value: "balanced", label: "Balanced (default)" },
  { value: "detailed", label: "Advanced (more context)" },
  { value: "verbose", label: "Maximum detail (full instructions)" },
] as const;

const SETTINGS_THEME = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: "#1668dc",
    colorBgContainer: "rgba(255, 255, 255, 0.04)",
    colorBorder: "#424242",
    colorText: "rgba(255, 255, 255, 0.88)",
    colorTextPlaceholder: "rgba(255, 255, 255, 0.25)",
    borderRadius: 6,
    fontSize: 14,
    controlHeight: 32,
  },
  components: {
    Select: {
      optionSelectedBg: "rgba(22, 104, 220, 0.2)",
    },
  },
} as const;

/** `0`/empty clears override (backend removes env). */
function llmMaxTokensPayload(n: number | undefined): number {
  if (n === undefined || n === null || Number.isNaN(Number(n))) return 0;
  const v = Math.floor(Number(n));
  return v > 0 ? v : 0;
}

/** Match backend `normalizePromptMode`: legacy `compact` → balanced. */
function normalizePromptModeUi(m: string | undefined): (typeof PROMPT_MODE_OPTIONS)[number]["value"] {
  const v = (m ?? "").trim();
  if (!v || v === "compact") return "balanced";
  return PROMPT_MODE_OPTIONS.some((o) => o.value === v)
    ? (v as (typeof PROMPT_MODE_OPTIONS)[number]["value"])
    : "balanced";
}

/** Searchable model dropdown */
function SearchableModelSelect({
  models,
  value,
  onChange,
  placeholder,
  currentNotInList,
}: {
  models: string[];
  value: string;
  onChange: (m: string) => void;
  placeholder?: string;
  currentNotInList?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!search.trim()) return models;
    const q = search.toLowerCase();
    return models.filter((m) => m.toLowerCase().includes(q));
  }, [models, search]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  return (
    <div className={`searchable-select ${open ? "searchable-select--open" : ""}`} ref={ref}>
      <button
        type="button"
        className="searchable-select-trigger"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="searchable-select-value">
          {value || <span className="placeholder">{placeholder || "Select..."}</span>}
        </span>
        <span className="searchable-select-arrow">
          <IconChevronDown size={16} />
        </span>
      </button>
      <div className="searchable-select-dropdown-shell" aria-hidden={!open}>
        <div className="searchable-select-dropdown-inner">
          <div className="searchable-select-dropdown">
            <input
              ref={inputRef}
              type="text"
              className="searchable-select-search"
              disabled={!open}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search models..."
              onKeyDown={(e) => {
                if (e.key === "Enter" && filtered.length === 1) {
                  onChange(filtered[0]);
                  setOpen(false);
                  setSearch("");
                }
              }}
            />
            <div className="searchable-select-list">
              {currentNotInList && value && (
                <button
                  type="button"
                  className="searchable-select-item active"
                  onClick={() => { onChange(value); setOpen(false); setSearch(""); }}
                >
                  {value} <span className="current-tag">(current)</span>
                </button>
              )}
              {filtered.length === 0 && (
                <div className="searchable-select-empty">No models found</div>
              )}
              {filtered.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`searchable-select-item ${m === value ? "active" : ""}`}
                  onClick={() => { onChange(m); setOpen(false); setSearch(""); }}
                >
                  {m}
                  {m === value && <span className="check"><IconCheck size={12} /></span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Uses `GET /v1/models` (or provider-specific `/openai/models`) — not Ollama native. */

interface Props {
  onClose: () => void;
}

interface OllamaProbe {
  state: "idle" | "loading" | "ok" | "error";
  models: string[];
  error?: string;
}

export function SettingsModal({ onClose }: Props) {
  const [s, setS] = useState<SettingsPayload | null>(null);
  const [apiKey, setApiKey] = useState("");
  /** Latest API key draft — ref avoids blur-before-save dropping the value. */
  const apiKeyRef = useRef("");
  const [apiKeyTouched, setApiKeyTouched] = useState(false);
  /** True while replacing a saved key (field empty, mask hidden). */
  const [apiKeyEditing, setApiKeyEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Cached list of locally-installed Ollama models. We probe lazily — only
  // when the user actually picks the ollama provider — so users on cloud
  // models pay zero cost for a feature they don't use.
  const [ollama, setOllama] = useState<OllamaProbe>({ state: "idle", models: [] });
  const probeSeqRef = useRef(0);
  /** OpenAI-compatible `/v1/models` probe (provider = local). */
  const [compat, setCompat] = useState<OllamaProbe>({ state: "idle", models: [] });
  const compatSeqRef = useRef(0);
  // Command-policy "YOLO" toggle — kept *separate* from the LLM settings
  // payload because policy lives in <workspace>/.pig-agents/policy.json
  // (per-workspace) rather than in the global app/.env file. We persist on
  // every flick rather than waiting for the Save button so behaviour matches
  // what the user clicked.
  const [autoApprove, setAutoApprove] = useState<boolean | null>(null);
  const [autoApproveWeb, setAutoApproveWeb] = useState<boolean | null>(null);
  const [autoSaving, setAutoSaving] = useState(false);
  /** Managed cloud providers use built-in endpoints unless the user expands "custom URL". */
  const [customBaseUrl, setCustomBaseUrl] = useState(false);
  /** Bumping this re-runs Ollama / OpenAI-compatible model probes (also after Save). */
  const [modelListRefreshKey, setModelListRefreshKey] = useState(0);
  const [modelListLoading, setModelListLoading] = useState(false);
  const [uiZoom, setUiZoom] = useState(100);
  const [uiZoomSaving, setUiZoomSaving] = useState(false);

  useEffect(() => {
    void pig.zoomGet().then((r) => setUiZoom(r.percent)).catch(() => { /* noop */ });
  }, []);

  async function applyUiZoom(percent: number) {
    setUiZoom(percent);
    setUiZoomSaving(true);
    try {
      const r = await pig.zoomSet(percent);
      setUiZoom(r.percent);
    } catch (err) {
      setMsg(`Zoom: ${(err as Error).message}`);
    } finally {
      setUiZoomSaving(false);
    }
  }

  useEffect(() => {
    api.getSettings().then(setS).catch((e) => setMsg(`Load error: ${(e as Error).message}`));
    api.getPolicy()
      .then(({ policy }) => {
        setAutoApprove(!!policy.autoApprove);
        setAutoApproveWeb(!!policy.autoApproveWeb);
      })
      .catch(() => {
        setAutoApprove(false);
        setAutoApproveWeb(false);
      });
  }, []);

  async function toggleAutoApprove(next: boolean) {
    setAutoApprove(next);
    setAutoSaving(true);
    try {
      const r = await api.setAutoApprove(next);
      setAutoApprove(!!r.autoApprove);
    } catch (err) {
      setAutoApprove(!next);
      setMsg(`Auto-approve toggle failed: ${(err as Error).message}`);
    } finally {
      setAutoSaving(false);
    }
  }

  async function toggleAutoApproveWeb(next: boolean) {
    setAutoApproveWeb(next);
    setAutoSaving(true);
    try {
      const r = await api.setAutoApproveWeb(next);
      setAutoApproveWeb(!!r.autoApproveWeb);
    } catch (err) {
      setAutoApproveWeb(!next);
      setMsg(`Auto-allow web toggle failed: ${(err as Error).message}`);
    } finally {
      setAutoSaving(false);
    }
  }

  // Auto-probe Ollama whenever the user is on (or switches to) the ollama
  // provider — and re-probe when they edit the Base URL so they get
  // immediate "yep this host works / nope it doesn't" feedback.
  useEffect(() => {
    if (!s) return;
    if (s.LLM_PROVIDER !== "ollama") return;
    const seq = ++probeSeqRef.current;
    setOllama({ state: "loading", models: [] });
    const t = window.setTimeout(() => {
      api.ollamaModels(s.BASE_URL || undefined)
        .then((r) => {
          if (probeSeqRef.current !== seq) return;
          if (r.ok) setOllama({ state: "ok", models: r.models || [] });
          else setOllama({ state: "error", models: [], error: r.error });
        })
        .catch((err) => {
          if (probeSeqRef.current !== seq) return;
          setOllama({ state: "error", models: [], error: (err as Error).message });
        });
    }, 250); // debounce typing in Base URL
    return () => window.clearTimeout(t);
  }, [s?.LLM_PROVIDER, s?.BASE_URL, modelListRefreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!s) return;
    if (!isOpenAiShapedProvider(s.LLM_PROVIDER)) return;
    const seq = ++compatSeqRef.current;
    setCompat({ state: "loading", models: [] });
    const t = window.setTimeout(() => {
      const def = s.INTEGRATIONS?.[s.LLM_PROVIDER]?.defaultBaseUrl;
      const probeBase = s.BASE_URL?.trim() || def || undefined;
      api.openaiCompatibleModels(probeBase)
        .then((r) => {
          if (compatSeqRef.current !== seq) return;
          if (r.ok) setCompat({ state: "ok", models: r.models || [] });
          else setCompat({ state: "error", models: [], error: r.error });
        })
        .catch((err) => {
          if (compatSeqRef.current !== seq) return;
          setCompat({ state: "error", models: [], error: (err as Error).message });
        });
    }, 250);
    return () => window.clearTimeout(t);
  }, [s?.LLM_PROVIDER, s?.BASE_URL, modelListRefreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const providerOptions = useMemo(() => {
    const ids = s?.PROVIDER_IDS?.length ? s.PROVIDER_IDS : FALLBACK_PROVIDER_OPTIONS.map((o) => o.value);
    return ids.map((id) => {
      const meta = s?.INTEGRATIONS?.[id];
      const fallback = FALLBACK_PROVIDER_OPTIONS.find((o) => o.value === id);
      return { value: id, label: meta?.label ?? fallback?.label ?? id };
    });
  }, [s?.PROVIDER_IDS, s?.INTEGRATIONS]);

  if (!s) return <Modal title="Settings" onClose={onClose}><div>Loading…</div></Modal>;

  function syncApiKey(value: string) {
    apiKeyRef.current = value;
    setApiKey(value);
    setApiKeyTouched(true);
  }

  function clearApiKeyField() {
    apiKeyRef.current = "";
    setApiKey("");
    setApiKeyTouched(false);
    setApiKeyEditing(false);
  }

  function enterApiKeyEdit() {
    apiKeyRef.current = "";
    setApiKey("");
    setApiKeyTouched(false);
    setApiKeyEditing(true);
  }

  function apiKeyDraftTrimmed(): string {
    return apiKeyRef.current.trim();
  }

  function apiKeySavePatch(hasStoredKey: boolean): Partial<SettingsPayload> {
    const draft = apiKeyDraftTrimmed();
    if (draft.length > 0) return { OPENAI_API_KEY: draft };
    if (apiKeyTouched && hasStoredKey) return { OPENAI_API_KEY: "" };
    return {};
  }

  async function refreshModelList() {
    const st = s;
    if (!st) return;
    setModelListLoading(true);
    setMsg(null);
    try {
      const mustSyncKey =
        apiKeyDraftTrimmed().length > 0 ||
        (apiKeyTouched && !apiKeyDraftTrimmed() && st.OPENAI_API_KEY_SET);
      if (mustSyncKey) {
        await api.saveSettings({
          LLM_PROVIDER: st.LLM_PROVIDER,
          BASE_URL: st.BASE_URL,
          MODEL: st.MODEL,
          MAX_CONTEXT_FILES: Number(st.MAX_CONTEXT_FILES),
          MAX_ITERATIONS: Number(st.MAX_ITERATIONS),
          PROMPT_MODE: normalizePromptModeUi(st.PROMPT_MODE),
          LLM_MAX_TOKENS: llmMaxTokensPayload(st.LLM_MAX_TOKENS),
          ...apiKeySavePatch(st.OPENAI_API_KEY_SET),
        });
        const fresh = await api.getSettings();
        setS(fresh);
        clearApiKeyField();
      }
      setModelListRefreshKey((k) => k + 1);
    } catch (err) {
      setMsg(`Load models: ${(err as Error).message}`);
    } finally {
      setModelListLoading(false);
    }
  }

  function field<K extends keyof SettingsPayload>(key: K, value: SettingsPayload[K]) {
    setS((cur) => {
      if (!cur) return cur;
      if ((key === "BASE_URL" || key === "MODEL") && cur.PROFILES) {
        const pid = cur.LLM_PROVIDER;
        const nextProfiles = { ...cur.PROFILES };
        const prev = nextProfiles[pid] ?? {
          baseUrl: cur.BASE_URL,
          model: cur.MODEL,
          apiKeySet: cur.OPENAI_API_KEY_SET,
        };
        nextProfiles[pid] = {
          baseUrl: key === "BASE_URL" ? (value as string) : prev.baseUrl,
          model: key === "MODEL" ? (value as string) : prev.model,
          apiKeySet: prev.apiKeySet ?? cur.OPENAI_API_KEY_SET,
        };
        return { ...cur, [key]: value, PROFILES: nextProfiles };
      }
      return { ...cur, [key]: value };
    });
  }

  function pickProvider(p: string) {
    setCustomBaseUrl(false);
    clearApiKeyField();
    setS((cur) => {
      if (!cur) return cur;
      const slot = cur.PROFILES?.[p];
      return {
        ...cur,
        LLM_PROVIDER: p,
        BASE_URL: slot?.baseUrl ?? "",
        MODEL: slot?.model ?? "",
        OPENAI_API_KEY_SET: slot?.apiKeySet ?? false,
      };
    });
    void api
      .saveSettings({ LLM_PROVIDER: p })
      .then(() => api.getSettings())
      .then(setS)
      .catch((e) => setMsg(`Switch provider: ${(e as Error).message}`));
  }

  async function save() {
    if (!s) return;
    setSaving(true); setMsg(null);
    try {
      const payload: Partial<SettingsPayload> = {
        LLM_PROVIDER: s.LLM_PROVIDER,
        BASE_URL: s.BASE_URL,
        MODEL: s.MODEL,
        MAX_CONTEXT_FILES: Number(s.MAX_CONTEXT_FILES),
        MAX_ITERATIONS: Number(s.MAX_ITERATIONS),
        PROMPT_MODE: normalizePromptModeUi(s.PROMPT_MODE),
        LLM_MAX_TOKENS: llmMaxTokensPayload(s.LLM_MAX_TOKENS),
        ...apiKeySavePatch(s.OPENAI_API_KEY_SET),
      };
      await api.saveSettings(payload);
      setMsg("Saved.");
      const fresh = await api.getSettings();
      setS(fresh);
      clearApiKeyField();
      setModelListRefreshKey((k) => k + 1);
    } catch (err) {
      setMsg(`Error: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  const isOllama = s.LLM_PROVIDER === "ollama";
  const isChatgpt = s.LLM_PROVIDER === "chatgpt";
  const isCursor = s.LLM_PROVIDER === "cursor";
  const openAiShaped = isOpenAiShapedProvider(s.LLM_PROVIDER);
  const integ = s.INTEGRATIONS?.[s.LLM_PROVIDER];
  const managedCloud =
    integ?.kind === "managed_cloud" ||
    (!s.INTEGRATIONS && s.LLM_PROVIDER !== "ollama" && s.LLM_PROVIDER !== "local");
  const showBaseUrlInput = isOllama || !managedCloud || customBaseUrl;

  const modelSelectList =
    openAiShaped && compat.state === "ok" && compat.models.length > 0
      ? compat.models
      : isOllama && ollama.state === "ok" && ollama.models.length > 0
        ? ollama.models
        : null;

  const showSavedApiKeyMask =
    !isOllama &&
    s.OPENAI_API_KEY_SET &&
    !apiKeyEditing &&
    !apiKeyTouched &&
    apiKey.length === 0;

  return (
    <Modal
      title="Settings"
      onClose={onClose}
      footer={
        <>
          {msg && <span style={{ marginRight: "auto", color: msg.startsWith("Error") ? "var(--bad)" : "var(--good)", fontSize: 12 }}>{msg}</span>}
          <button onClick={onClose}>Close</button>
          <button
            className="primary"
            disabled={saving}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <ConfigProvider theme={SETTINGS_THEME}>
      <div className="settings-form">
      <div className="settings-section">
        <div className="settings-section-title">Appearance</div>
        <div className="settings-row">
          <label>UI zoom</label>
          <div className="settings-zoom-row">
            <Slider
              min={80}
              max={200}
              step={10}
              value={uiZoom}
              disabled={uiZoomSaving}
              onChange={(v) => void applyUiZoom(v)}
              tooltip={{ formatter: (v) => `${v}%` }}
            />
            <span className="settings-zoom-value">{uiZoom}%</span>
            <Button size="small" disabled={uiZoomSaving} onClick={() => void applyUiZoom(100)}>
              Reset 100%
            </Button>
          </div>
          <div className="hint">
            Shortcuts: <kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>Ctrl</kbd>+<kbd>−</kbd> / <kbd>Ctrl</kbd>+<kbd>0</kbd>, or <kbd>Ctrl</kbd> + scroll.
            Saved automatically and restored when you reopen the app.
          </div>
        </div>
      </div>

      <div className="settings-row">
        <label>LLM Provider</label>
        <Select
          value={s.LLM_PROVIDER}
          onChange={pickProvider}
          options={providerOptions}
        />
        <div className="hint">
          {managedCloud && !customBaseUrl && (
            <>
              {" "}
              <button
                type="button"
                className="hint-link"
                onClick={() => setCustomBaseUrl(true)}
              >
                Custom endpoint…
              </button>
            </>
          )}
        </div>
      </div>

      {isCursor && (
        <div className="settings-row">
          <div className="hint" style={{ gridColumn: "1 / -1" }}>
            <strong>Cursor Cloud Agents API</strong> — not OpenAI <code>/chat/completions</code>.
            Base URL must be <code>https://api.cursor.com/v1</code> (do <em>not</em> paste <code>/agents</code>).
            Each LLM call creates a short-lived cloud agent (no GitHub repo) and streams the reply.
            Slower than direct chat APIs; local file tools still run in Pig Agents, not on Cursor cloud.
          </div>
        </div>
      )}

      {!isOllama && (
        <div className="settings-row">
          <label>API key</label>
          <Input.Password
            readOnly={showSavedApiKeyMask}
            className={showSavedApiKeyMask ? "settings-api-key-saved" : undefined}
            value={showSavedApiKeyMask ? "••••••••••••" : apiKey}
            autoComplete="new-password"
            onFocus={() => {
              if (showSavedApiKeyMask) enterApiKeyEdit();
            }}
            onBlur={() => {
              if (!apiKeyRef.current.trim()) {
                setApiKeyEditing(false);
                setApiKeyTouched(false);
              } else {
                setApiKeyEditing(false);
              }
            }}
            onChange={(e) => {
              if (showSavedApiKeyMask) return;
              syncApiKey(e.target.value);
            }}
            onPaste={() => setApiKeyTouched(true)}
            placeholder={
              isChatgpt ? "sk-…" : isCursor ? "Cursor API key (Dashboard → API Keys)" : "API key for this Base URL (OpenAI, Google AI, OpenRouter, …)"
            }
            visibilityToggle={!showSavedApiKeyMask}
          />
          <div className="hint">
            {s.OPENAI_API_KEY_SET
              ? <><span style={{ color: "var(--good)" }}>● Saved for this provider</span> — focus to paste a new key; Save with an empty field keeps the current key.</>
              : <><span style={{ color: "var(--warn)" }}>○ Not set</span> — required for most cloud APIs; local servers often accept any string.</>}
          </div>
        </div>
      )}

      {showBaseUrlInput && (
        <div className="settings-row">
          <label>{managedCloud && customBaseUrl ? "Custom Base URL" : "Base URL"}</label>
          <Input
            value={s.BASE_URL}
            onChange={(e) => field("BASE_URL", e.target.value)}
            placeholder={
              isOllama
                ? "http://localhost:11434  (Ollama default)"
                : isCursor
                  ? "https://api.cursor.com/v1"
                  : isChatgpt
                    ? "https://api.openai.com/v1"
                    : "https://…  ·  http://host:port/v1"
            }
          />
          <div className="hint">
            {isOllama ? (
              <>
                Talks to Ollama's <strong>native</strong> API (<code>/api/chat</code>) — no Bearer token, no
                gateway, NDJSON streaming. Default <code>http://localhost:11434</code> works out of the box if
                you ran <code>ollama serve</code>.
              </>
            ) : managedCloud && customBaseUrl ? (
              <>
                <button
                  type="button"
                  className="hint-link"
                  onClick={() => {
                    setCustomBaseUrl(false);
                    field("BASE_URL", "");
                  }}
                >
                  Reset to built-in endpoint
                </button>
                {" "}— OpenAI-compatible <code>/v1</code> (or provider-specific path).
              </>
            ) : (
              <>OpenAI-compatible <code>/v1</code> base; used to list models and call chat.</>
            )}
          </div>
        </div>
      )}

      <div className="settings-row">
        <label>Model</label>
        <div className="settings-model-row-inner">
          {modelSelectList ? (
            <SearchableModelSelect
              models={modelSelectList}
              value={s.MODEL}
              onChange={(m) => field("MODEL", m)}
              placeholder={isOllama ? "Pick an installed model" : "Pick a model"}
              currentNotInList={s.MODEL.trim() !== "" && !modelSelectList.includes(s.MODEL)}
            />
          ) : (
            <Input
              value={s.MODEL}
              onChange={(e) => field("MODEL", e.target.value)}
              placeholder={
                isChatgpt ? "gpt-4o-mini"
                  : isOllama ? "llama3.2  ·  qwen2.5-coder  ·  …"
                    : "model id from your server"
              }
            />
          )}
          {(isOllama || openAiShaped) && (
            <Button
              size="small"
              disabled={saving || modelListLoading}
              onClick={() => void refreshModelList()}
              title="Re-fetch models from the server. If you just pasted an API key, it is saved first."
            >
              {modelListLoading ? "Loading…" : "Load models"}
            </Button>
          )}
        </div>
        {isOllama && (
          <div className="hint">
            {ollama.state === "loading" && <>Probing <code>{s.BASE_URL || "http://localhost:11434"}</code>…</>}
            {ollama.state === "ok" && (
              ollama.models.length > 0
                ? <><span style={{ color: "var(--good)" }}>●</span> Found {ollama.models.length} installed model{ollama.models.length === 1 ? "" : "s"}.</>
                : <><span style={{ color: "var(--warn)" }}>○</span> Ollama is reachable but you haven't pulled any models yet. Run <code>ollama pull llama3.2</code>.</>
            )}
            {ollama.state === "error" && (
              <><span style={{ color: "var(--bad)" }}>●</span> Can't reach Ollama at <code>{s.BASE_URL || "http://localhost:11434"}</code>. Is <code>ollama serve</code> running? <span style={{ opacity: 0.7 }}>({ollama.error})</span></>
            )}
          </div>
        )}
        {openAiShaped && (
          <div className="hint">
            {compat.state === "loading" && (
              <>Loading model list from <code>{s.BASE_URL?.trim() || s.INTEGRATIONS?.[s.LLM_PROVIDER]?.defaultBaseUrl || "default"}</code>…</>
            )}
            {compat.state === "ok" && (
              compat.models.length > 0
                ? <><span style={{ color: "var(--good)" }}>●</span> {compat.models.length} model{compat.models.length === 1 ? "" : "s"} from the server API.</>
                : <><span style={{ color: "var(--warn)" }}>○</span> Server responded but listed no models — type a model id manually.</>
            )}
            {compat.state === "error" && (
              <><span style={{ color: "var(--warn)" }}>●</span> Could not auto-load models — enter the model id manually. <span style={{ opacity: 0.7 }}>({compat.error})</span></>
            )}
          </div>
        )}
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Agent runtime</div>

        <div className="settings-row">
          <label>Max context files</label>
          <InputNumber
            min={1}
            max={200}
            value={s.MAX_CONTEXT_FILES}
            onChange={(v) => field("MAX_CONTEXT_FILES", v ?? 1)}
            style={{ width: "100%" }}
          />
          <div className="hint">
            How many <strong>existing workspace files</strong> are ranked and injected into the prompt as context each turn — not how many new files are written in parallel, and not extra LLM calls.
            Higher = more code visible to the agent, more tokens. Recommended: <code>10–20</code>.
          </div>
        </div>

        <div className="settings-row">
          <label>Max iterations</label>
          <InputNumber
            min={1}
            max={1000}
            value={s.MAX_ITERATIONS}
            onChange={(v) => field("MAX_ITERATIONS", v ?? 1)}
            style={{ width: "100%" }}
          />
          <div className="hint">
            Hard cap on the ReAct loop (THOUGHT → ACTION steps). Use <code>30–100</code> for complex multi-file projects,
            <code>200+</code> for large refactors. Defaults to <code>50</code>.
          </div>
        </div>

        <div className="settings-row">
          <label>Max completion tokens</label>
          <InputNumber
            min={64}
            max={131072}
            placeholder="Auto"
            value={s.LLM_MAX_TOKENS && s.LLM_MAX_TOKENS > 0 ? s.LLM_MAX_TOKENS : null}
            onChange={(v) => field("LLM_MAX_TOKENS", v ?? 0)}
            style={{ width: "100%" }}
          />
          <div className="hint">
            Per-call output budget (<code>max_tokens</code>). Leave empty for auto (mode-derived). Recommended: <code>4096</code>–<code>16384</code> for complex coding tasks. Lower for slow TPM providers like Groq (<code>512</code>).
          </div>
        </div>

        <div className="settings-row">
          <label>Prompt mode</label>
          <Select
            value={normalizePromptModeUi(s.PROMPT_MODE)}
            onChange={(v) => field("PROMPT_MODE", normalizePromptModeUi(v))}
            options={PROMPT_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
          <div className="hint">
            Controls system prompt length and how much file/history context is attached each turn — higher levels use more tokens but give the model fuller instructions (good for difficult multi-file work).
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Command approvals</div>
        <div className="settings-row settings-row-toggle">
          <label htmlFor="auto-approve-toggle">Auto-approve commands</label>
          <div className="toggle-wrap">
            <button
              id="auto-approve-toggle"
              type="button"
              role="switch"
              aria-checked={autoApprove === true}
              disabled={autoApprove === null || autoSaving}
              className={`toggle-switch ${autoApprove ? "on" : "off"}`}
              onClick={() => toggleAutoApprove(!autoApprove)}
              title={autoApprove ? "Click to disable" : "Click to enable"}
            >
              <span className="toggle-knob" />
              <span className="toggle-label">{autoApprove === null ? "…" : autoApprove ? "ON" : "OFF"}</span>
            </button>
          </div>
        </div>
        <div className="hint">
          When <strong>ON</strong>, the agent runs every command without asking — except those on the
          built-in deny-list (<code>rm -rf /</code>, <code>sudo</code>, <code>git push --force</code>,
          <code>npm publish</code>, fork bombs, etc.) which are <em>always</em> blocked. Persisted in
          <code>.pig-agents/policy.json</code> per workspace.
        </div>

        <div className="settings-row settings-row-toggle" style={{ marginTop: 12 }}>
          <label htmlFor="auto-approve-web-toggle">Auto-allow web tools</label>
          <div className="toggle-wrap">
            <button
              id="auto-approve-web-toggle"
              type="button"
              role="switch"
              aria-checked={autoApproveWeb === true}
              disabled={autoApproveWeb === null || autoSaving}
              className={`toggle-switch ${autoApproveWeb ? "on" : "off"}`}
              onClick={() => toggleAutoApproveWeb(!autoApproveWeb)}
              title={autoApproveWeb ? "Click to disable" : "Click to enable"}
            >
              <span className="toggle-knob" />
              <span className="toggle-label">{autoApproveWeb === null ? "…" : autoApproveWeb ? "ON" : "OFF"}</span>
            </button>
          </div>
        </div>
        <div className="hint">
          When <strong>ON</strong>, <code>web_fetch</code> and <code>web_search</code> calls skip the
          approval modal. Localhost / private-network hosts are still rejected at the tool layer
          regardless of this flag (SSRF guard). Same per-workspace policy file as above.
        </div>
      </div>
      </div>
      </ConfigProvider>
    </Modal>
  );
}
