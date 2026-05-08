import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Highlight, themes } from "prism-react-renderer";
import { useEffect, useState } from "react";
import { IconCheck, IconCopy } from "./Icons";

interface ActiveEditorState { path: string | null; }

function useActiveEditor(): ActiveEditorState {
  const [state, setState] = useState<ActiveEditorState>(() => ({
    path: (window as unknown as { __ba_activeFile?: string | null }).__ba_activeFile ?? null,
  }));
  useEffect(() => {
    function onChange(e: Event) {
      const detail = (e as CustomEvent<{ path: string | null }>).detail;
      setState({ path: detail?.path ?? null });
    }
    window.addEventListener("ba:active-file", onChange as EventListener);
    return () => window.removeEventListener("ba:active-file", onChange as EventListener);
  }, []);
  return state;
}

function dispatchEditorAction(kind: "insert" | "replace", text: string, target?: string | null) {
  window.dispatchEvent(new CustomEvent("ba:editor-action", { detail: { kind, text, target: target ?? null } }));
}

function CodeBlock({ language, value }: { language: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const [acted, setActed] = useState<"insert" | "replace" | null>(null);
  const active = useActiveEditor();

  // Allow "ts:path/to/file.ts" syntax — language part before the colon, target file after.
  const [lang, target] = (() => {
    const idx = language.indexOf(":");
    if (idx > -1) return [language.slice(0, idx), language.slice(idx + 1)];
    return [language, ""];
  })();

  const targetPath = target || active.path || "";
  const targetName = targetPath ? targetPath.split("/").pop() : "";

  function copy() {
    navigator.clipboard.writeText(value).catch(() => { /* noop */ });
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  function insert() {
    dispatchEditorAction("insert", value, targetPath);
    setActed("insert");
    setTimeout(() => setActed(null), 1200);
  }
  function apply() {
    dispatchEditorAction("replace", value, targetPath);
    setActed("replace");
    setTimeout(() => setActed(null), 1200);
  }

  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="lang">{lang || "text"}</span>
        {targetName && <span className="target" title={targetPath}>→ {targetName}</span>}
        <span className="cb-spacer" />
        <button type="button" onClick={copy} title="Copy code to clipboard">
          {copied ? <><IconCheck size={13} style={{ marginRight: 3 }} />Copied</> : <><IconCopy size={13} style={{ marginRight: 3 }} />Copy</>}
        </button>
        <button type="button" onClick={insert} disabled={!targetPath} title={targetPath ? `Insert at cursor in ${targetName}` : "Open a file in the editor first"}>
          {acted === "insert" ? <><IconCheck size={13} style={{ marginRight: 3 }} />Inserted</> : "↳ Insert"}
        </button>
        <button type="button" onClick={apply} disabled={!targetPath} className="apply" title={targetPath ? `Replace contents of ${targetName}` : "Open a file in the editor first"}>
          {acted === "replace" ? <><IconCheck size={13} style={{ marginRight: 3 }} />Applied</> : <><IconCheck size={13} style={{ marginRight: 3 }} />Apply</>}
        </button>
      </div>
      <Highlight code={value.replace(/\n$/, "")} language={(lang || "text") as any} theme={themes.vsDark}>
        {({ className, style, tokens, getLineProps, getTokenProps }) => (
          <pre className={className} style={{ ...style, background: "transparent" }}>
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                {line.map((token, key) => <span key={key} {...getTokenProps({ token })} />)}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ inline, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || "");
            const value = String(children).replace(/\n$/, "");
            if (!inline && (match || value.includes("\n"))) {
              return <CodeBlock language={match?.[1] || ""} value={value} />;
            }
            return <code className={className} {...props}>{children}</code>;
          },
          a({ href, children }: any) {
            return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
