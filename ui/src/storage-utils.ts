// Shared localStorage helpers.

export function getStorageBool(key: string, defaultValue = true): boolean {
  const v = localStorage.getItem(key);
  if (v === null) return defaultValue;
  return v === "1" || v === "true";
}

export function setStorageBool(key: string, value: boolean): void {
  localStorage.setItem(key, value ? "1" : "0");
}

/** Parse a JSON value from localStorage; null when it is missing or malformed. */
export function getStorageJson<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}
