import { KEY_UPDATE_LAST_CHECK, KEY_UPDATE_DISMISSED_VERSION } from "./storage-keys.ts";

const { invoke } = window.__TAURI__.core;
const { getVersion } = window.__TAURI__.app;

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
const AUTO_DISMISS_MS = 30_000;
const STALE_CHECK_INTERVAL_MS = 60_000;

export async function checkForUpdate(): Promise<void> {
  try {
    const last = localStorage.getItem(KEY_UPDATE_LAST_CHECK);
    if (last && Date.now() - new Date(last).getTime() < CHECK_INTERVAL_MS) return;

    const currentVersion = await getVersion();
    const result = await invoke<{ version: string; html_url: string } | null>("check_for_update", {
      currentVersion,
    });

    localStorage.setItem(KEY_UPDATE_LAST_CHECK, new Date().toISOString());
    if (!result) return;

    const dismissed = localStorage.getItem(KEY_UPDATE_DISMISSED_VERSION);
    if (dismissed === result.version) return;

    showUpdateToast(result.version, result.html_url);
  } catch {
    // Update check failures are silent
  }
}

/**
 * Detect a stale process: after `brew upgrade` the .app bundle on disk is
 * replaced but the running process keeps executing the old binary. Compare
 * the on-disk bundle version with the running version on window focus and
 * offer a restart.
 */
export function watchBundleVersion(): void {
  let lastCheck = 0;
  let notified = false;
  window.addEventListener("focus", async () => {
    if (notified || Date.now() - lastCheck < STALE_CHECK_INTERVAL_MS) return;
    lastCheck = Date.now();
    try {
      const bundle = await invoke<string | null>("get_bundle_version");
      if (!bundle || bundle === (await getVersion())) return;
      notified = true;
      showRestartToast(bundle);
    } catch {
      // Dev builds have no bundle; failures are silent
    }
  });
}

function showRestartToast(version: string): void {
  const toast = document.createElement("div");
  toast.className = "update-toast";
  toast.innerHTML = `
    <div class="update-toast-header">
      <span>Updated to v${version} — restart to apply</span>
      <button class="update-toast-close" aria-label="Dismiss">&times;</button>
    </div>
    <button class="update-toast-restart">Restart Now</button>
  `;
  toast.querySelector(".update-toast-close")!.addEventListener("click", () => toast.remove());
  toast
    .querySelector(".update-toast-restart")!
    .addEventListener("click", () => invoke("relaunch_app"));
  document.body.appendChild(toast);
}

function showUpdateToast(version: string, htmlUrl: string): void {
  const toast = document.createElement("div");
  toast.className = "update-toast";
  toast.innerHTML = `
    <div class="update-toast-header">
      <span>New version v${version} available</span>
      <button class="update-toast-close" aria-label="Dismiss">&times;</button>
    </div>
    <code>brew upgrade markupsidedown</code>
    <a href="${htmlUrl}" target="_blank" rel="noopener">View on GitHub</a>
  `;

  const dismiss = () => {
    localStorage.setItem(KEY_UPDATE_DISMISSED_VERSION, version);
    toast.remove();
  };

  toast.querySelector(".update-toast-close")!.addEventListener("click", dismiss);
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), AUTO_DISMISS_MS);
}
