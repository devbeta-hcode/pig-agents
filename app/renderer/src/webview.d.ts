/// <reference types="react" />

/** Electron `<webview>` guest element in the renderer. */
export interface ElectronWebviewElement extends HTMLElement {
  getWebContentsId(): number;
  src: string;
  partition: string;
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<ElectronWebviewElement> & {
          src?: string;
          partition?: string;
          allowpopups?: boolean | "";
          webpreferences?: string;
        },
        ElectronWebviewElement
      >;
    }
  }
}

export {};
