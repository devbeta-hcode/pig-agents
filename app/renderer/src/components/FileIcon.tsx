import { Icon, addCollection } from "@iconify/react";
import vscodeIcons from "@iconify-json/vscode-icons/icons.json";

// Bundle the entire vscode-icons collection (the same SVGs the famous VSCode
// "vscode-icons" extension ships) so file/folder icons render offline and
// look identical to a real IDE. The JSON is ~600KB raw / ~150KB gzipped —
// acceptable for a developer-facing app where these icons are everywhere.
addCollection(vscodeIcons as Parameters<typeof addCollection>[0]);

const PREFIX = "vscode-icons:";

// Extension (lowercased, no leading dot) → vscode-icons icon id.
const EXT_MAP: Record<string, string> = {
  // TypeScript / JavaScript
  ts: "file-type-typescript",
  tsx: "file-type-reactts",
  mts: "file-type-typescript",
  cts: "file-type-typescript",
  js: "file-type-js-official",
  jsx: "file-type-reactjs",
  mjs: "file-type-js-official",
  cjs: "file-type-js-official",

  // Data / config
  json: "file-type-json",
  jsonc: "file-type-json",
  json5: "file-type-json",
  yml: "file-type-yaml",
  yaml: "file-type-yaml",
  toml: "file-type-toml",
  ini: "file-type-ini",
  conf: "file-type-ini",
  env: "file-type-dotenv",
  xml: "file-type-xml",
  csv: "file-type-text",
  tsv: "file-type-text",

  // Docs / text
  md: "file-type-markdown",
  mdx: "file-type-mdx",
  rst: "file-type-text",
  txt: "file-type-text",
  log: "file-type-log",
  pdf: "file-type-pdf2",

  // Web
  html: "file-type-html",
  htm: "file-type-html",
  svg: "file-type-svg",
  css: "file-type-css",
  scss: "file-type-scss",
  sass: "file-type-sass",
  less: "file-type-less",
  vue: "file-type-vue",
  svelte: "file-type-svelte",
  astro: "file-type-astro",

  // Backend languages
  py: "file-type-python",
  pyi: "file-type-python",
  ipynb: "file-type-jupyter",
  rb: "file-type-ruby",
  go: "file-type-go",
  rs: "file-type-rust",
  java: "file-type-java",
  kt: "file-type-kotlin",
  kts: "file-type-kotlin",
  swift: "file-type-swift",
  c: "file-type-c",
  h: "file-type-cheader",
  cpp: "file-type-cpp",
  cc: "file-type-cpp",
  cxx: "file-type-cpp",
  hpp: "file-type-cppheader",
  cs: "file-type-csharp",
  php: "file-type-php",
  lua: "file-type-lua",
  r: "file-type-r",
  scala: "file-type-scala",
  ex: "file-type-elixir",
  exs: "file-type-elixir",
  erl: "file-type-erlang",
  hs: "file-type-haskell",
  zig: "file-type-zig",
  dart: "file-type-dartlang",
  ada: "file-type-ada",

  // Shell
  sh: "file-type-shell",
  bash: "file-type-shell",
  zsh: "file-type-shell",
  fish: "file-type-shell",
  ps1: "file-type-powershell",
  bat: "file-type-shell",
  cmd: "file-type-shell",

  // Data / DB
  sql: "file-type-sql",
  sqlite: "file-type-sql",
  db: "file-type-binary",

  // Schemas / IDL
  graphql: "file-type-graphql",
  gql: "file-type-graphql",
  proto: "file-type-protobuf",

  // Media
  png: "file-type-image",
  jpg: "file-type-image",
  jpeg: "file-type-image",
  gif: "file-type-image",
  webp: "file-type-image",
  ico: "file-type-image",
  bmp: "file-type-image",
  avif: "file-type-image",
  mp4: "file-type-video",
  webm: "file-type-video",
  mov: "file-type-video",
  mp3: "file-type-audio",
  wav: "file-type-audio",
  ogg: "file-type-audio",
  flac: "file-type-audio",

  // Fonts
  ttf: "file-type-font",
  woff: "file-type-font",
  woff2: "file-type-font",
  otf: "file-type-font",
  eot: "file-type-font",

  // Archives
  zip: "file-type-zip",
  tar: "file-type-zip",
  gz: "file-type-zip",
  tgz: "file-type-zip",
  rar: "file-type-zip",
  "7z": "file-type-zip",
};

// Whole filename (lowercased) → icon. Highest priority — overrides EXT_MAP
// so well-known config files carry their tool's brand mark instead of a
// generic JSON/YAML one.
const NAME_MAP: Record<string, string> = {
  "package.json": "file-type-npm",
  "package-lock.json": "file-type-npm",
  ".npmrc": "file-type-npm",
  ".npmignore": "file-type-npm",
  "yarn.lock": "file-type-yarn",
  ".yarnrc": "file-type-yarn",
  ".yarnrc.yml": "file-type-yarn",
  "pnpm-lock.yaml": "file-type-pnpm",
  "pnpm-workspace.yaml": "file-type-pnpm",
  ".pnpmrc": "file-type-pnpm",
  "bun.lockb": "file-type-bun",
  "bun.lock": "file-type-bun",
  "bunfig.toml": "file-type-bun",

  "tsconfig.json": "file-type-tsconfig",
  "tsconfig.base.json": "file-type-tsconfig",
  "jsconfig.json": "file-type-js-official",

  "vite.config.ts": "file-type-vite",
  "vite.config.js": "file-type-vite",
  "vite.config.mjs": "file-type-vite",
  "vite.config.cjs": "file-type-vite",
  "vitest.config.ts": "file-type-vite",
  "vitest.config.js": "file-type-vite",
  "next.config.js": "file-type-next",
  "next.config.mjs": "file-type-next",
  "next.config.ts": "file-type-next",
  "nuxt.config.ts": "file-type-nuxt",
  "nuxt.config.js": "file-type-nuxt",
  "webpack.config.js": "file-type-webpack",
  "webpack.config.ts": "file-type-webpack",
  "rollup.config.js": "file-type-rollup",
  "rollup.config.mjs": "file-type-rollup",
  "esbuild.config.js": "file-type-esbuild",
  "tailwind.config.js": "file-type-tailwind",
  "tailwind.config.ts": "file-type-tailwind",
  "tailwind.config.cjs": "file-type-tailwind",
  "postcss.config.js": "file-type-postcss",
  "postcss.config.cjs": "file-type-postcss",

  ".eslintrc": "file-type-eslint",
  ".eslintrc.json": "file-type-eslint",
  ".eslintrc.js": "file-type-eslint",
  ".eslintrc.cjs": "file-type-eslint",
  ".eslintrc.yaml": "file-type-eslint",
  ".eslintignore": "file-type-eslint",
  "eslint.config.js": "file-type-eslint",
  "eslint.config.mjs": "file-type-eslint",
  "eslint.config.cjs": "file-type-eslint",
  ".prettierrc": "file-type-prettier",
  ".prettierrc.json": "file-type-prettier",
  ".prettierrc.js": "file-type-prettier",
  ".prettierrc.yaml": "file-type-prettier",
  ".prettierignore": "file-type-prettier",
  "prettier.config.js": "file-type-prettier",
  ".editorconfig": "file-type-editorconfig",
  ".browserslistrc": "file-type-browserslist",

  "dockerfile": "file-type-docker",
  ".dockerignore": "file-type-docker",
  "docker-compose.yml": "file-type-docker2",
  "docker-compose.yaml": "file-type-docker2",
  "compose.yml": "file-type-docker2",
  "compose.yaml": "file-type-docker2",

  ".gitignore": "file-type-git",
  ".gitattributes": "file-type-git",
  ".gitmodules": "file-type-git",
  ".gitkeep": "file-type-git",
  ".gitconfig": "file-type-git",

  ".env": "file-type-dotenv",
  ".env.local": "file-type-dotenv",
  ".env.example": "file-type-dotenv",
  ".env.sample": "file-type-dotenv",
  ".env.development": "file-type-dotenv",
  ".env.production": "file-type-dotenv",
  ".env.test": "file-type-dotenv",

  "readme.md": "file-type-markdown",
  "readme": "file-type-text",
  "readme.txt": "file-type-text",
  "license": "file-type-license",
  "license.md": "file-type-license",
  "license.txt": "file-type-license",
  "changelog.md": "file-type-markdown",
  "changelog": "file-type-markdown",
  "contributing.md": "file-type-markdown",
  "code_of_conduct.md": "file-type-markdown",
  "security.md": "file-type-markdown",
  "agents.md": "file-type-agents",
  "todo.md": "file-type-todo",
  "todo": "file-type-todo",

  "makefile": "file-type-cmake",
  "cmakelists.txt": "file-type-cmake",
  "cargo.toml": "file-type-cargo",
  "cargo.lock": "file-type-cargo",
  "go.mod": "file-type-go",
  "go.sum": "file-type-go",
  "requirements.txt": "file-type-python",
  "requirements-dev.txt": "file-type-python",
  "pyproject.toml": "file-type-python",
  "pipfile": "file-type-python",
  "pipfile.lock": "file-type-python",
  "gemfile": "file-type-ruby",
  "gemfile.lock": "file-type-ruby",
  "rakefile": "file-type-ruby",
  "podfile": "file-type-ruby",

  codeowners: "file-type-codeowners",
  ".codeowners": "file-type-codeowners",
};

// Folder basename (lowercased) → vscode-icons folder id (CLOSED form).
// Open variant just appends `-opened`. Falls back to default-folder.
const FOLDER_MAP: Record<string, string> = {
  src: "folder-type-src",
  source: "folder-type-src",
  app: "folder-type-app",
  apps: "folder-type-app",
  public: "folder-type-public",
  static: "folder-type-public",
  assets: "folder-type-images",
  images: "folder-type-images",
  img: "folder-type-images",
  fonts: "folder-type-fonts",
  font: "folder-type-fonts",
  css: "folder-type-css",
  styles: "folder-type-css",
  test: "folder-type-test",
  tests: "folder-type-test",
  __tests__: "folder-type-test",
  spec: "folder-type-test",
  specs: "folder-type-test",
  e2e: "folder-type-test",
  docs: "folder-type-docs",
  doc: "folder-type-docs",
  documentation: "folder-type-docs",
  config: "folder-type-config",
  configs: "folder-type-config",
  conf: "folder-type-config",
  api: "folder-type-api",
  server: "folder-type-server",
  backend: "folder-type-server",
  client: "folder-type-client",
  frontend: "folder-type-client",
  ui: "folder-type-client",
  web: "folder-type-client",
  components: "folder-type-component",
  component: "folder-type-component",
  widgets: "folder-type-component",
  lib: "folder-type-library",
  libs: "folder-type-library",
  library: "folder-type-library",
  helpers: "folder-type-helper",
  helper: "folder-type-helper",
  utils: "folder-type-helper",
  util: "folder-type-helper",
  hooks: "folder-type-hook",
  hook: "folder-type-hook",
  views: "folder-type-view",
  view: "folder-type-view",
  pages: "folder-type-view",
  routes: "folder-type-route",
  route: "folder-type-route",
  models: "folder-type-model",
  model: "folder-type-model",
  controllers: "folder-type-controller",
  controller: "folder-type-controller",
  services: "folder-type-services",
  service: "folder-type-services",
  interfaces: "folder-type-interfaces",
  interface: "folder-type-interfaces",
  types: "folder-type-typescript",
  typings: "folder-type-typescript",
  plugins: "folder-type-plugin",
  plugin: "folder-type-plugin",
  themes: "folder-type-theme",
  theme: "folder-type-theme",
  dist: "folder-type-dist",
  build: "folder-type-dist",
  out: "folder-type-dist",
  node_modules: "folder-type-node",
  ".git": "folder-type-git",
  ".github": "folder-type-github",
  ".gitlab": "folder-type-gitlab",
  ".vscode": "folder-type-vscode",
  ".cursor": "folder-type-cursor",
  ".claude": "folder-type-claude",
  locale: "folder-type-locale",
  locales: "folder-type-locale",
  i18n: "folder-type-locale",
  middleware: "folder-type-middleware",
  middlewares: "folder-type-middleware",
  redux: "folder-type-redux",
  graphql: "folder-type-graphql",
  db: "folder-type-db",
  database: "folder-type-db",
  databases: "folder-type-db",
  log: "folder-type-log",
  logs: "folder-type-log",
  temp: "folder-type-temp",
  tmp: "folder-type-temp",
};

function fileIconName(name: string): string {
  const lower = name.toLowerCase();
  if (NAME_MAP[lower]) return NAME_MAP[lower];

  // Compound extensions first.
  if (lower.endsWith(".d.ts")) return "file-type-typescriptdef";
  if (lower.endsWith(".tsbuildinfo")) return "file-type-tsconfig";

  // Common config-file families: tsconfig.*.json, jest.config.*, etc.
  if (lower.startsWith("tsconfig.") && lower.endsWith(".json")) return "file-type-tsconfig";
  if (lower.startsWith("jest.config.")) return "file-type-jest";
  if (lower.startsWith("babel.config.") || lower === ".babelrc" || lower.startsWith(".babelrc.")) {
    return "file-type-babel";
  }
  if (lower.startsWith("vitest.config.")) return "file-type-vite";

  const dotIdx = lower.lastIndexOf(".");
  if (dotIdx > 0) {
    const ext = lower.slice(dotIdx + 1);
    if (EXT_MAP[ext]) return EXT_MAP[ext];
  }
  return "default-file";
}

function folderIconName(name: string, expanded: boolean): string {
  const lower = name.toLowerCase();
  const base = FOLDER_MAP[lower];
  if (base) return expanded ? `${base}-opened` : base;
  return expanded ? "default-folder-opened" : "default-folder";
}

interface FileIconProps {
  name: string;
  isDir?: boolean;
  expanded?: boolean;
  /** Rendered px size (square). 16 by default. */
  size?: number;
  className?: string;
}

export function FileIcon({ name, isDir, expanded, size = 16, className }: FileIconProps) {
  const cls = `file-icon-svg${className ? ` ${className}` : ""}`;
  const iconName = isDir ? folderIconName(name, !!expanded) : fileIconName(name);
  return (
    <Icon
      className={cls}
      icon={`${PREFIX}${iconName}`}
      width={size}
      height={size}
      aria-hidden
    />
  );
}
