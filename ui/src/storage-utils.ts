// Shared helpers for boolean localStorage toggles.

export function getStorageBool(key: string, defaultValue = true): boolean {
  const v = localStorage.getItem(key);
  if (v === null) return defaultValue;
  return v === "1" || v === "true";
}

export function setStorageBool(key: string, value: boolean): void {
  localStorage.setItem(key, value ? "1" : "0");
}
