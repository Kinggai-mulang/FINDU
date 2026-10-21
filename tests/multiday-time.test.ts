import {it,expect} from 'vitest';
import {utcAxisLabel,utcRangeSummary} from '../src/time';

it('distinguishes midnight, GPS week rollover and year boundaries in UTC',()=>{
 expect(utcAxisLabel(Date.parse('2024-03-09T23:59:45Z'))).toBe('03-09\n23:59:45');
 expect(utcAxisLabel(Date.parse('2024-03-10T00:00:00Z'))).toBe('03-10\n00:00:00');
 expect(utcAxisLabel(Date.parse('2025-01-01T00:00:00Z'))).toBe('01-01\n00:00:00');
 expect(utcAxisLabel(NaN)).toBe('—');
});
it('shows full UTC dates and elapsed days without mistaking GPS dates for UTC dates',()=>{
 const label=utcRangeSummary(Date.parse('2024-03-05T23:59:42Z'),Date.parse('2024-03-20T23:59:27Z'));
 expect(label).toContain('2024-03-05 23:59:42');expect(label).toContain('14 天 23 小时 59 分 45 秒');
 expect(label).toContain('16 个 UTC 日期');
 expect(utcRangeSummary(undefined,0)).toBe('');expect(utcRangeSummary(1,0)).toBe('');
});
