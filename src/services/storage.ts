export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`findyou.${key}`);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
export function writeStored(key: string, value: unknown) {
  localStorage.setItem(`findyou.${key}`, JSON.stringify(value));
}
