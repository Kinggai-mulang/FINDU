import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const moduleUrl = pathToFileURL(path.resolve('scripts/platform.mjs')).href;
const evaluate = (expression: string) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {target,outputDirectory,assertEnginePair} from ${JSON.stringify(moduleUrl)};console.log(JSON.stringify(${expression}));`,
      ],
      { encoding: 'utf8' },
    ),
  );

describe('native package platforms', () => {
  it('rejects mixed engine sources before building the pair', () => {
    const manifest = { commit: 'a', source_sha256: 'b', build_id: 'c' };
    expect(evaluate(`assertEnginePair(${JSON.stringify(manifest)},${JSON.stringify(manifest)}) ?? true`)).toBe(true);
    for (const key of Object.keys(manifest)) {
      const other = { ...manifest, [key]: 'different' };
      expect(
        evaluate(
          `(()=>{try{assertEnginePair(${JSON.stringify(manifest)},${JSON.stringify(other)})}catch{return true}return false})()`,
        ),
      ).toBe(true);
    }
  });
  it('keeps Windows and Linux engine/runtime names distinct', () => {
    expect(evaluate("target('win32','x64')")).toMatchObject({
      id: 'windows-x64',
      application: 'FINDU.exe',
      solver: 'IPSPOS.exe',
      python: 'python.exe',
    });
    expect(evaluate("target('linux','x64')")).toMatchObject({
      id: 'linux-x64',
      application: 'FINDU',
      solver: 'IPSPOS',
      python: 'bin/python3',
      engine: 'resources/engine/linux-x64',
    });
  });
  it('refuses to package over the output root or outside deliverables', () => {
    for (const folder of ['deliverables', '../outside']) {
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {outputDirectory} from ${JSON.stringify(moduleUrl)};outputDirectory('0.8.4');`,
        ],
        { env: { ...process.env, FINDYOU_PACKAGE_DIR: folder } },
      );
      expect(result.status).not.toBe(0);
    }
  });
});
