// Tauri global API (withGlobalTauri: true)
interface TauriCore {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
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

interface TauriGlobal {
  core: TauriCore;
  dialog: TauriDialog;
  fs: TauriFs;
  event?: TauriEvent;
}

declare global {
  interface Window {
    __TAURI__: TauriGlobal;
  }
}

export {};
