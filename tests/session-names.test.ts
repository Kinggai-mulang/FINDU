import { expect, it } from 'vitest';
import { sessionName, compactSessionName, nextOrdinal } from '../src/services/session-names';

it('uses numbered original filenames without opt suffix and preserves distinct name endings when truncated', () => {
  const a = sessionName('IPSClient-TrimbelAlloy-WHU.opt', 1),
    b = sessionName('IPSClient-TrimbelAlloy-PLANET.opt', 2);
  expect(a).toBe('01_IPSClient-TrimbelAlloy-WHU');
  expect(nextOrdinal([a, b])).toBe(3);
  expect(compactSessionName(a, 22)).toContain('WHU');
  expect(compactSessionName(b, 22)).toContain('PLANET');
  expect(Array.from(compactSessionName(b, 22))).toHaveLength(22);
});
