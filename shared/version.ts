// Kept in sync by `npm run version:set`; checked by CI and releases.
export const pluginVersion = "0.4.1";
export const pluginRepository = "Makiras/paseo-notify-ts";
export const pluginId = "paseo-notifier";

const stable = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
export function stableVersion(tag: string): string | null {
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  return stable.test(version) ? version : null;
}
export function newerVersion(candidate: string, current: string): boolean {
  if (!stableVersion(candidate) || !stableVersion(current)) return false;
  const left = candidate.replace(/^v/, "").split(".").map(Number);
  const right = current.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i]! > right[i]!;
  }
  return false;
}
