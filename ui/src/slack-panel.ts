import { getSlackToken } from "./settings.ts";

const { invoke } = window.__TAURI__.core;

let panelEl: HTMLElement | null = null;
let onInsert: ((body: string, ref_: string) => void) | null = null;
let statusEl: HTMLElement | null = null;

export function initSlackPanel(
  el: HTMLElement,
  { onContent }: { onContent: (body: string, ref_: string) => void },
) {
  panelEl = el;
  onInsert = onContent;
  render();
}

function render() {
  if (!panelEl) return;
  panelEl.innerHTML = "";

  // Input row
  const inputRow = document.createElement("div");
  inputRow.className = "slack-input-row";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "slack-input";
  input.placeholder = "Slack URL or channel ID";
  inputRow.appendChild(input);

  const fetchBtn = document.createElement("button");
  fetchBtn.className = "slack-fetch-btn";
  fetchBtn.textContent = "Import";
  fetchBtn.addEventListener("click", () => fetchSlack(input));
  inputRow.appendChild(fetchBtn);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") fetchSlack(input);
  });

  panelEl.appendChild(inputRow);

  // Status
  statusEl = document.createElement("div");
  statusEl.className = "slack-status";
  panelEl.appendChild(statusEl);
}

function setStatus(text: string, cls: string) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = `slack-status ${cls}`;
}

async function fetchSlack(input: HTMLInputElement) {
  const raw = input.value.trim();
  if (!raw) return;

  const token = getSlackToken();
  if (!token) {
    setStatus("Set Slack Bot Token in Settings first", "slack-status-error");
    return;
  }

  // Parse the input to get channel ID and optional thread_ts
  let channelId: string;
  let threadTs: string | null;

  try {
    const parsed = await invoke<[string, string | null]>("parse_slack_input", { input: raw });
    channelId = parsed[0];
    threadTs = parsed[1];
  } catch (e) {
    setStatus(`${e}`, "slack-status-error");
    return;
  }

  setStatus("Importing\u2026", "slack-status-pending");

  try {
    let result: { markdown: string; message_count: number; channel_name?: string };

    if (threadTs) {
      result = await invoke("fetch_slack_thread", {
        token,
        channelId,
        threadTs,
      });
    } else {
      result = await invoke("fetch_slack_channel", {
        token,
        channelId,
      });
    }

    const label = result.channel_name ? `#${result.channel_name}` : channelId;
    const suffix = threadTs ? " (thread)" : "";
    setStatus(
      `Imported ${result.message_count} messages from ${label}${suffix}`,
      "slack-status-ok",
    );
    onInsert?.(result.markdown, `${label}${suffix}`);
  } catch (e: unknown) {
    setStatus(`Error: ${e}`, "slack-status-error");
  }
}
