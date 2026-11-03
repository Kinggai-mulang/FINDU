/** Selecting satellites to leave out of a statistic: quick groups, ranges typed as text, and set operations. */

export interface SatelliteGroup {
  key: string;
  label: string;
  /** Which PRN numbers the group covers, in words, for the tooltip. */
  hint: string;
  has: (number: number) => boolean;
}

/**
 * Groups by constellation letter. Only BeiDou has generations people leave out on purpose, and the PRN is the only
 * thing that tells them apart, so this is approximate; orbit types come from the orbit itself, see `classMembers`.
 */
export const satelliteGroups: Record<string, SatelliteGroup[]> = {
  C: [
    { key: 'bds2', label: 'BDS-2', hint: '按编号 C01–C18（近似）', has: (n) => n <= 18 },
    { key: 'bds3', label: 'BDS-3', hint: '按编号 C19 及以上（近似）', has: (n) => n >= 19 },
  ],
};

/** Orbit types in the order they are offered. */
export const orbitClassNames = ['GEO', 'IGSO', 'MEO'];

/**
 * Satellites of one system by orbit type, from the classes the comparison measured (`classes`: satellite -> type), not
 * from the PRN, which a constellation renumbers and upgrades. Empty classes give no groups.
 */
export function classGroups(system: string, classes: Record<string, string>, all: string[]) {
  const own = all.filter((s) => s[0] === system && classes[s]);
  const present = orbitClassNames.filter((name) => own.some((s) => classes[s] === name));
  // one class is the whole system, which has its own button
  return present.length < 2
    ? []
    : present.map((name) => ({ key: name, label: name, members: own.filter((s) => classes[s] === name) }));
}

export const satelliteNumber = (sat: string) => Number(sat.slice(1));
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const groupSatellites = (system: string, group: SatelliteGroup, all: string[]) =>
  all.filter((s) => s[0] === system && group.has(satelliteNumber(s)));

/**
 * Satellites named by text such as `C01-C10, G13 E`: a PRN, a range of PRNs of one system, or a bare system letter for
 * all of its satellites. Names that match nothing in `all` come back in `unknown`.
 */
export function parseSatellites(text: string, all: string[]): { sats: string[]; unknown: string[] } {
  const found = new Set<string>();
  const unknown: string[] = [];
  for (const token of text
    .toUpperCase()
    .split(/[\s,;，；、]+/)
    .filter(Boolean)) {
    let hit: string[] = [];
    let m = /^([A-Z])$/.exec(token);
    if (m) hit = all.filter((s) => s[0] === m![1]);
    else if ((m = /^([A-Z])(\d{1,2})$/.exec(token))) hit = all.filter((s) => s === `${m![1]}${m![2].padStart(2, '0')}`);
    else if ((m = /^([A-Z])(\d{1,2})[-~–—]([A-Z]?)(\d{1,2})$/.exec(token)) && (!m[3] || m[3] === m[1])) {
      const [lo, hi] = [Number(m[2]), Number(m[4])].sort((a, b) => a - b);
      hit = all.filter((s) => s[0] === m![1] && satelliteNumber(s) >= lo && satelliteNumber(s) <= hi);
    }
    if (hit.length) hit.forEach((s) => found.add(s));
    else unknown.push(token);
  }
  return { sats: [...found].sort(order), unknown };
}

/** The exclusion list with `sats` added (`exclude`) or taken out. */
export function setExcluded(excluded: string[], sats: string[], exclude: boolean): string[] {
  const next = new Set(excluded);
  for (const s of sats) {
    if (exclude) next.add(s);
    else next.delete(s);
  }
  return [...next].sort(order);
}

/** A group button: exclude all of `sats`, or restore them when every one of them is already excluded. */
export function toggleExcluded(excluded: string[], sats: string[]): string[] {
  const all = sats.length > 0 && sats.every((s) => excluded.includes(s));
  return setExcluded(excluded, sats, !all);
}

export function invertExcluded(excluded: string[], sats: string[]): string[] {
  const set = new Set(excluded);
  return setExcluded(excluded, sats, false)
    .concat(sats.filter((s) => !set.has(s)))
    .sort(order);
}
