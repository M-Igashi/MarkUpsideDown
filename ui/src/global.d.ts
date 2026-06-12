// Tauri global API (withGlobalTauri: true)
interface TauriCore {
  invoke<T = unknown>(
    cmd: string,
    args?: Record<string, unknown> | ArrayBuffer | Uint8Array,
    options?: { headers?: Record<string, string> },
  ): Promise<T>;
  convertFileSrc(filePath: string, protocol?: string): string;
}

interface TauriDialog {
  open(options?: Record<string, unknown>): Promise<string | null>;
  save(options?: Record<string, unknown>): Promise<string | null>;
  confirm(message: string, options?: Record<string, unknown>): Promise<boolean>;
  message(message: string, options?: Record<string, unknown>): Promise<void>;
}

interface TauriFs {
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
}

interface TauriEvent {
  listen<T = unknown>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
}

interface TauriWebviewWindow {
  label: string;
}

interface TauriWebviewWindowModule {
  getCurrentWebviewWindow(): TauriWebviewWindow;
}

interface TauriPath {
  join(...paths: string[]): Promise<string>;
}

interface TauriApp {
  getVersion(): Promise<string>;
}

interface TauriGlobal {
  core: TauriCore;
  dialog: TauriDialog;
  fs: TauriFs;
  path: TauriPath;
  app: TauriApp;
  event?: TauriEvent;
  webviewWindow?: TauriWebviewWindowModule;
}

interface Window {
  __TAURI__: TauriGlobal;
}

declare module "*.css";

declare module "idiomorph" {
  export const Idiomorph: {
    morph(
      oldNode: Element | ChildNode | string,
      newContent: Element | ChildNode | string,
      options?: Record<string, unknown>,
    ): void;
  };
}
