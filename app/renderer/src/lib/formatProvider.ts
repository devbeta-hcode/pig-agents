/**
 * Prettier-backed "Format Document" for Monaco — fully offline (the standalone
 * build + plugins run in the renderer, no external tool needed). Registers one
 * document-formatting provider per supported web language; Monaco's built-in
 * `editor.action.formatDocument` (Shift+Alt+F / right-click → Format Document)
 * then routes through it. Python/Go/Rust etc. are out of scope here (they need
 * native tools — a later phase).
 */

type Monaco = typeof import("monaco-editor");

// Lazily loaded so the editor mounts fast; first format pulls Prettier in.
let prettierMod: typeof import("prettier/standalone") | null = null;
const plugins: Record<string, unknown> = {};
let loadPromise: Promise<void> | null = null;

async function loadPrettier(): Promise<void> {
  if (prettierMod) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const [std, babel, estree, html, postcss, markdown, typescript, yaml] = await Promise.all([
      import("prettier/standalone"),
      import("prettier/plugins/babel"),
      import("prettier/plugins/estree"),
      import("prettier/plugins/html"),
      import("prettier/plugins/postcss"),
      import("prettier/plugins/markdown"),
      import("prettier/plugins/typescript"),
      import("prettier/plugins/yaml"),
    ]);
    prettierMod = std;
    Object.assign(plugins, { babel, estree, html, postcss, markdown, typescript, yaml });
  })();
  return loadPromise;
}

/** Map a Monaco language id to a Prettier parser + the plugins it needs. */
function parserConfig(lang: string): { parser: string; plugins: unknown[] } | null {
  switch (lang) {
    case "typescript":
      return { parser: "typescript", plugins: [plugins.typescript, plugins.estree] };
    case "javascript":
      return { parser: "babel", plugins: [plugins.babel, plugins.estree] };
    case "json":
      return { parser: "json", plugins: [plugins.babel, plugins.estree] };
    case "html":
      return { parser: "html", plugins: [plugins.html, plugins.babel, plugins.estree, plugins.postcss] };
    case "css":
      return { parser: "css", plugins: [plugins.postcss] };
    case "scss":
      return { parser: "scss", plugins: [plugins.postcss] };
    case "less":
      return { parser: "less", plugins: [plugins.postcss] };
    case "markdown":
      return { parser: "markdown", plugins: [plugins.markdown] };
    case "yaml":
      return { parser: "yaml", plugins: [plugins.yaml] };
    default:
      return null;
  }
}

const SUPPORTED = [
  "typescript",
  "javascript",
  "json",
  "html",
  "css",
  "scss",
  "less",
  "markdown",
  "yaml",
];

let registered = false;

/** Register Prettier formatters once for the whole Monaco instance. */
export function registerPrettierFormatters(monaco: Monaco): void {
  if (registered) return;
  registered = true;

  for (const lang of SUPPORTED) {
    monaco.languages.registerDocumentFormattingEditProvider(lang, {
      async provideDocumentFormattingEdits(model) {
        await loadPrettier();
        const cfg = parserConfig(model.getLanguageId());
        if (!cfg || !prettierMod) return [];
        try {
          const formatted = await prettierMod.format(model.getValue(), {
            parser: cfg.parser,
            // Prettier plugin modules are opaque here; the standalone API accepts them.
            plugins: cfg.plugins as never[],
            tabWidth: 2,
            printWidth: 100,
            semi: true,
            singleQuote: false,
          });
          if (formatted === model.getValue()) return [];
          return [{ range: model.getFullModelRange(), text: formatted }];
        } catch {
          // Syntax error / unsupported construct — leave the buffer untouched.
          return [];
        }
      },
    });
  }
}
