export interface Satellite {
  prn: string;
  system: string;
  azimuth: number | null;
  elevation: number | null;
  used: boolean | null;
  signals: { slot: number; band: string; signal: string; cn0: number | null; used: boolean | null }[];
}
export interface SatelliteSnapshot {
  schemaVersion: 1;
  runId: string;
  sequence: number;
  week: number;
  tow: number;
  publishedAt: number;
  satellites: Satellite[];
}
export const systemColors: Record<string, string> = {
  GPS: '#69A8FF',
  BDS: '#D8323A',
  GAL: '#E7BD66',
  GLO: '#B49AF5',
  QZSS: '#62CDB8',
};
export const systemInk: Record<string, string> = {
  GPS: '#0B1730',
  BDS: '#FFFFFF',
  GAL: '#271E0B',
  GLO: '#211835',
  QZSS: '#08261F',
};
export const systemNames: Record<string, string> = {
  GPS: 'GPS',
  BDS: '北斗',
  GAL: 'Galileo',
  GLO: 'GLONASS',
  QZSS: 'QZSS',
};
const star = (x: number, y: number, size: number, color: string) =>
  `<use href="#s" fill="${color}" transform="translate(${x} ${y}) scale(${size})"/>`;
const flags: Record<string, string> = {
  GPS: `<rect width="30" height="20" fill="white"/>${Array.from({ length: 7 }, (_, i) => `<rect y="${(i * 40) / 13}" width="30" height="${20 / 13}" fill="#B22234"/>`).join('')}<rect width="13" height="10.77" fill="#3C3B6E"/>${Array.from({ length: 9 }, (_, row) => Array.from({ length: row % 2 ? 5 : 6 }, (_, col) => star(1.1 + col * 2.15 + (row % 2 ? 1.075 : 0), 0.8 + row * 1.15, 0.48, 'white')).join('')).join('')}`,
  BDS: `<rect width="30" height="20" fill="#DE2910"/>${star(5, 5, 3, '#FFDE00')}${[
    [10, 2],
    [12, 4],
    [12, 7],
    [10, 9],
  ]
    .map(([x, y]) => star(x, y, 1, '#FFDE00'))
    .join('')}`,
  GAL: `<rect width="30" height="20" fill="#003399"/>${Array.from({ length: 12 }, (_, i) => star(15 + 6 * Math.sin((i * Math.PI) / 6), 10 - 6 * Math.cos((i * Math.PI) / 6), 1, '#FFCC00')).join('')}`,
  GLO: '<rect width="30" height="20" fill="white"/><path d="M0 6.67H30V13.33H0Z" fill="#0039A6"/><path d="M0 13.33H30V20H0Z" fill="#D52B1E"/>',
  QZSS: '<rect width="30" height="20" fill="white"/><circle cx="15" cy="10" r="6" fill="#BC002D"/>',
};
export const systemFlags = Object.fromEntries(
  Object.entries(flags).map(([key, body]) => [
    key,
    'data:image/svg+xml,' +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20"><defs><path id="s" d="M0 -1L.2245 -.309L.9511 -.309L.3633 .118L.5878 .809L0 .382L-.5878 .809L-.3633 .118L-.9511 -.309L-.2245 -.309Z"/></defs>${body}</svg>`,
      ),
  ]),
);
export function satelliteCounts(satellites: Satellite[]) {
  const unique = [...new Map(satellites.map((s) => [s.prn, s])).values()];
  const bands = new Map<string, { system: string; band: string; count: number }>();
  for (const s of unique)
    for (const band of new Set(s.signals.map((f) => f.band))) {
      const key = s.system + ':' + band;
      const row = bands.get(key) ?? { system: s.system, band, count: 0 };
      row.count++;
      bands.set(key, row);
    }
  return {
    total: unique.length,
    used: unique.filter((s) => s.used === true).length,
    unknown: unique.filter((s) => s.used === null).length,
    bands: [...bands.values()].sort((a, b) => a.system.localeCompare(b.system) || a.band.localeCompare(b.band)),
  };
}
