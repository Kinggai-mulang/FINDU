import { useSyncExternalStore } from 'react';
import type { BiasSet, OrbitMode, ProductSet } from '../../contracts';
import { readStored, writeStored } from './storage';

export type InputKind = 'bia' | 'clk' | 'sp3';

/**
 * One product as the user hands it over: whatever files it has. The orbit / clock page and the bias page share these
 * sets, so a product dropped once (bias, clock and orbit together) is compared on both pages with what each can use.
 */
export interface InputSet {
  name: string;
  bia: string[];
  clk: string[];
  sp3: string[];
  /** Legacy manual choice, retained when restoring older saved inputs. */
  apc?: boolean;
  orbitMode?: OrbitMode;
  orbitSource?: 'has' | 'b2b';
  /** Sign convention of a test product's biases; only the bias page uses it. */
  sign?: 'auto' | 'keep' | 'invert';
}
export interface Inputs {
  reference: InputSet;
  tests: InputSet[];
}

export const kindLabels: Record<InputKind, string> = { bia: 'BIA', clk: 'CLK', sp3: 'SP3' };

/** Bias-SINEX, RINEX clock and SP3 orbit files are told apart by name; compressed files are reported, not guessed at. */
export function classifyInputPath(path: string): InputKind | 'compressed' | null {
  const name = path.replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? '';
  if (/\.(gz|z)$/.test(name)) return 'compressed';
  if (/\.clk(_\d+s?)?$/.test(name) || /\.clock$/.test(name)) return 'clk';
  if (/\.(sp3|eph|orb)$/.test(name)) return 'sp3';
  return /\.(bia|bsx|bias)$/.test(name) ? 'bia' : null;
}

export const emptySet = (name = ''): InputSet => ({ name, bia: [], clk: [], sp3: [], sign: 'auto' });

/** Preserve explicit choices saved by older versions; new sets default to automatic assessment. */
export const orbitMode = (set: Pick<InputSet, 'orbitMode' | 'apc'>): OrbitMode =>
  set.orbitMode ?? (typeof set.apc === 'boolean' ? (set.apc ? 'remove' : 'keep') : 'auto');

/** Add dropped or chosen paths; each path is kept once, whatever kind it is. */
export function addInputPaths(set: InputSet, paths: string[]): { set: InputSet; rejected: string[] } {
  const next: Record<InputKind, string[]> = { bia: [...set.bia], clk: [...set.clk], sp3: [...set.sp3] };
  const rejected: string[] = [];
  for (const path of paths) {
    const kind = classifyInputPath(path);
    if (kind === 'compressed' || kind === null) rejected.push(path);
    else if (!next[kind].includes(path)) next[kind].push(path);
  }
  return {
    set: {
      ...set,
      bia: next.bia.sort(),
      clk: next.clk.sort(),
      sp3: next.sp3.sort(),
      orbitSource: next.sp3.length === set.sp3.length ? set.orbitSource : undefined,
    },
    rejected,
  };
}

export const removeInputPath = (set: InputSet, path: string): InputSet => ({
  ...set,
  bia: set.bia.filter((p) => p !== path),
  clk: set.clk.filter((p) => p !== path),
  sp3: set.sp3.filter((p) => p !== path),
  orbitSource: set.sp3.includes(path) ? undefined : set.orbitSource,
});

/** The part of a set the orbit / clock comparison uses. */
export const toProductSet = (set: InputSet): ProductSet => ({
  name: set.name,
  sp3: set.sp3,
  clk: set.clk,
  apc: !!set.apc,
  orbitMode: orbitMode(set),
  orbitSource: set.orbitSource,
});

/** The part of a set the bias comparison uses; clocks and orbits ride along for the narrow-lane and the satellite classes. */
export const toBiasSet = (set: InputSet): BiasSet => ({
  name: set.name,
  files: set.bia,
  clocks: set.clk,
  orbits: set.sp3,
  sign: set.sign ?? 'auto',
});

/** Name a test product is compared under: its own, or "对比产品 n" by its place among all test products. */
export const testName = (set: InputSet, index: number) => set.name?.trim() || `对比产品 ${index + 1}`;

/** Test products that have none of the files a comparison needs; they are left out of it, and the page says so. */
export const without = (inputs: Inputs, need: 'sp3' | 'bia'): string[] =>
  inputs.tests.flatMap((t, i) => (t[need].length ? [] : [testName(t, i)]));

/** What keeps a comparison from running, empty when it can. */
export function problem(inputs: Inputs, need: 'sp3' | 'bia'): string {
  const what = need === 'sp3' ? 'SP3 轨道文件' : 'BIA 偏差文件';
  if (!inputs.reference[need].length) return `参考产品里还没有 ${what}`;
  if (!inputs.tests.some((t) => t[need].length)) return `还没有带 ${what}的对比产品`;
  return '';
}

const KEY = 'compareInputs';
const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((p) => typeof p === 'string') : []);
const restore = (value: Partial<InputSet> | undefined, name: string): InputSet => ({
  name: typeof value?.name === 'string' ? value.name : name,
  bia: list(value?.bia),
  clk: list(value?.clk),
  sp3: list(value?.sp3),
  apc: typeof value?.apc === 'boolean' ? value.apc : undefined,
  orbitMode: ['auto', 'keep', 'remove'].includes(value?.orbitMode ?? '') ? value?.orbitMode : undefined,
  orbitSource: value?.orbitSource === 'has' || value?.orbitSource === 'b2b' ? value.orbitSource : undefined,
  sign: value?.sign === 'keep' || value?.sign === 'invert' ? value.sign : 'auto',
});
function load(): Inputs {
  const saved = readStored<Partial<Inputs>>(KEY, {});
  const tests = Array.isArray(saved.tests) ? saved.tests : [];
  return {
    reference: restore(saved.reference, '参考产品'),
    tests: tests.length ? tests.map((t, i) => restore(t, `对比产品 ${i + 1}`)) : [emptySet('对比产品 1')],
  };
}

let current: Inputs | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => (current ??= load());
/** Changes are given as functions of the latest inputs: a drop that finishes later must not undo one that came first. */
function setInputs(change: Inputs | ((latest: Inputs) => Inputs)) {
  const next = typeof change === 'function' ? change(snapshot()) : change;
  current = next;
  try {
    writeStored(KEY, next);
  } catch {
    /* the inputs are only a convenience */
  }
  listeners.forEach((listener) => listener());
}

/** The reference and test products of both comparison pages, kept across pages and sessions. */
export const useInputs = (): [Inputs, typeof setInputs] => [useSyncExternalStore(subscribe, snapshot), setInputs];
