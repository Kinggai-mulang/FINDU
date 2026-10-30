import type { ResultSet } from '../../contracts';

/**
 * Decoder for the binary result transfer written by `src-tauri/src/wire.rs` (`import_analysis`, `open_analysis`,
 * `native_result`). Rows come back as the same plain objects the former JSON produced, with the same key order,
 * so analysis code is unchanged. Layout and the lossless rules are documented in wire.rs.
 *
 * Building ~340 000 row objects for two 47 h results takes a few hundred milliseconds per result, so the work is
 * time-sliced: the page keeps painting and handling input while a long result loads.
 */
type Column = {
  name: string;
  kind: 'i16' | 'i32' | 'f32' | 'f64' | 'time' | 'text' | 'json';
  offset?: number;
  scale?: number;
  labels?: string[];
  values?: unknown[];
};
type Table = { rows: number; columns: Column[] };
type Header = { results: { meta: Omit<ResultSet, 'config'>; epochs: Table; diagnostics: Table }[] };
type Row = Record<string, unknown>;

/** Same table as POW10 in wire.rs: exact powers of ten, so code / 10^scale is bit-identical on both sides. */
const POW10 = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9];
const CHUNK_ROWS = 2048;
const SLICE_MS = 12;

export async function decodeResults(buffer: ArrayBuffer): Promise<Omit<ResultSet, 'config'>[]> {
  const headerLength = new DataView(buffer).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength))) as Header;
  const base = Math.ceil((4 + headerLength) / 8) * 8;
  const results: Omit<ResultSet, 'config'>[] = [];
  for (const r of header.results) {
    const epochs = await rows(buffer, base, r.epochs);
    const diagnostics = await rows(buffer, base, r.diagnostics);
    results.push({
      ...r.meta,
      epochs: epochs as unknown as ResultSet['epochs'],
      diagnostics: diagnostics as ResultSet['diagnostics'],
    });
  }
  return results;
}

/** Writes rows `from..to` of one column into prebuilt row objects. */
function fill(buffer: ArrayBuffer, base: number, n: number, c: Column): (out: Row[], from: number, to: number) => void {
  const name = c.name;
  const at = base + (c.offset ?? 0);
  switch (c.kind) {
    case 'i16':
    case 'i32': {
      const codes = c.kind === 'i16' ? new Int16Array(buffer, at, n) : new Int32Array(buffer, at, n);
      const nil = c.kind === 'i16' ? -0x8000 : -0x80000000;
      const scale = POW10[c.scale ?? 0];
      return (out, from, to) => {
        for (let i = from; i < to; i++) out[i][name] = codes[i] === nil ? null : codes[i] / scale;
      };
    }
    case 'f32':
    case 'f64': {
      const values = c.kind === 'f32' ? new Float32Array(buffer, at, n) : new Float64Array(buffer, at, n);
      return (out, from, to) => {
        for (let i = from; i < to; i++) out[i][name] = Number.isNaN(values[i]) ? null : values[i];
      };
    }
    case 'time': {
      const ms = new Float64Array(buffer, at, n);
      return (out, from, to) => {
        for (let i = from; i < to; i++) out[i][name] = Number.isNaN(ms[i]) ? null : new Date(ms[i]).toISOString();
      };
    }
    case 'text': {
      const codes = new Uint16Array(buffer, at, n);
      const labels = c.labels ?? [];
      return (out, from, to) => {
        for (let i = from; i < to; i++) out[i][name] = codes[i] === 0xffff ? null : labels[codes[i]];
      };
    }
    default: {
      const values = c.values ?? [];
      return (out, from, to) => {
        for (let i = from; i < to; i++) out[i][name] = values[i];
      };
    }
  }
}

async function rows(buffer: ArrayBuffer, base: number, table: Table): Promise<Row[]> {
  const n = table.rows;
  const fills = table.columns.map((c) => fill(buffer, base, n, c));
  // Rows are copied from one template whose fields already hold numbers and null, so every row shares a single
  // fast-mode hidden class. Adding the keys one by one would turn each row into a dictionary (~3× the memory).
  const template: Row = {};
  for (const value of [0, 0.5, null]) for (const c of table.columns) template[c.name] = value;
  const out = new Array<Row>(n);
  let slice = performance.now();
  for (let from = 0; from < n; from += CHUNK_ROWS) {
    const to = Math.min(n, from + CHUNK_ROWS);
    for (let i = from; i < to; i++) out[i] = { ...template };
    for (const f of fills) f(out, from, to);
    if (performance.now() - slice > SLICE_MS) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      slice = performance.now();
    }
  }
  return out;
}
