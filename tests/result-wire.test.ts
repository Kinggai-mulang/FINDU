import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeResults } from '../src/services/result-wire';

// Bytes and expected JSON are written by `wire::tests::page_fixture_is_current` in src-tauri/src/wire.rs.
const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

describe('binary result transfer', () => {
  it('decodes every column kind into the rows the JSON transfer produced', async () => {
    const bytes = readFileSync(fixture('result-wire.bin'));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const expected = JSON.parse(readFileSync(fixture('result-wire.json'), 'utf8'));
    const decoded = await decodeResults(buffer);
    expect(decoded).toStrictEqual(expected);
    // Bit-exact, including the sign of zero, and the key order of the former JSON rows.
    expect(Object.is(decoded[0].diagnostics![0].ZWDUCor, -0)).toBe(true);
    expect(Object.keys(decoded[0].diagnostics![0])).toEqual(Object.keys(expected[0].diagnostics[0]));
    expect(Object.keys(decoded[0].epochs[0])).toEqual(Object.keys(expected[0].epochs[0]));
  });
});
