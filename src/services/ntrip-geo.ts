/** Great-circle distance in kilometres; the table has no map, so nearness is the main way to choose a base. */
export function distanceKm(a: [number, number], b: [number, number]) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b[0] - a[0]) * rad) / 2) ** 2 +
    Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(((b[1] - a[1]) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}
export function parsePosition(text: string): [number, number] | null {
  const parts = text
    .split(/[,\s;，]+/)
    .filter(Boolean)
    .map(Number);
  return parts.length === 2 && parts.every(Number.isFinite) && Math.abs(parts[0]) <= 90 && Math.abs(parts[1]) <= 180
    ? [parts[0], parts[1]]
    : null;
}
