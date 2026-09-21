const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const Calc=require('../docs/js/calc.js');
test('quality remains incomplete when one selected work has missing scores',()=>{
 const pillar={criteria:[{id:'a',weightCreative:100,weightFormal:100}]};
 assert.equal(Calc.computeQualityPillar(pillar,{first:{a:5}},['first','second'],'creative',[],1).pillarScore,null);
 assert.equal(Calc.computeQualityPillar(pillar,{first:{a:5},second:{a:3}},['first','second'],'creative',[],1).pillarScore,4);
});
test('writes and deletes follow actual sheet column order',()=>{
 let written,deleted;
 const sheet={getDataRange:()=>({getValues:()=>[['title','id','quarter'],['original','w','2026-Q1']]}),getRange:()=>({setValues:values=>{written=values;}}),deleteRow:n=>{deleted=n;},appendRow:()=>assert.fail('must update existing row')};
 const c=vm.createContext({sheet});vm.runInContext(fs.readFileSync('api/Code.gs','utf8'),c);
 vm.runInContext('getSheet_=()=>sheet; invalidateSheetCache_=()=>{};',c);
 vm.runInContext("upsertRow_('WorkLog',{id:'w',title:'updated',quarter:'2026-Q2'})",c);
 assert.equal(JSON.stringify(written),'[["updated","w","2026-Q2"]]');
 vm.runInContext("deleteRow_('WorkLog','w')",c);assert.equal(deleted,2);
});
