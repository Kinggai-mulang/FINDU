import {describe,it,expect} from 'vitest';
import {diagnosticValue} from '../src/components/DiagnosticChart';
describe('diagnostic display units and ADOP bounds',()=>{
 it('shows phase in mm without changing its input',()=>{const raw=0.0013;expect(diagnosticValue(raw,1000)).toBe(1.3);expect(raw).toBe(0.0013);expect(diagnosticValue(null,1000)).toBeNull();});
 it('floors valid tiny and rounded zero ADOP values, retains unknowns',()=>{expect(diagnosticValue(0.000001,1,true)).toBe(0.0001);expect(diagnosticValue(0,1,true)).toBe(0.0001);expect(diagnosticValue(0.1,1,true)).toBe(0.1);for(const raw of [null,undefined,NaN,Infinity,-1])expect(diagnosticValue(raw,1,true)).toBeNull();});
});
