import {it,expect} from 'vitest';
import {analysisReport} from '../src/services/analysis-report';
import {buildAnalysis} from '../src/analysis';
import {defaultConfig} from '../src/domain';
it('exports self-contained evidence without executing user labels or inventing empty precision',()=>{
 const a=buildAnalysis([{id:'a',name:'<script>alert(1)</script>',station:'WHU',source:'ipspos',config:defaultConfig,epochs:[]}],{window:{},cohort:'own',baselineId:'a',reference:null,motion:'unknown'});
 const html=analysisReport(a,{reference:null,settings:{},cohort:'own',range:{},baselineId:'a',events:[]});
 expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');expect(html).toContain('无独立真值');expect(html).not.toContain('src="http');expect(html).toContain('共同历元 0');
});
