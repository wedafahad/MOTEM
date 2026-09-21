const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(source = fs.readFileSync('api/Code.gs','utf8')) {
  const employees = [{id:'boss'}, {id:'lead',managerId:'boss'}, {id:'writer',managerId:'lead'}, {id:'outside',managerId:'other'}];
  const rows = [];
  for(let i=0;i<60;i++) rows.push({id:String(i),employeeId:'writer',evaluatorId:'lead',quarter:'2026-Q3',status:'submitted',pillarScores:{quality:5},selfAssessment:{c:4},selfAssessmentStatus:'draft'});
  rows.push({id:'outside',employeeId:'outside',evaluatorId:'other',quarter:'2026-Q3',status:'approved',pillarScores:{quality:3},selfAssessment:{c:3},selfAssessmentStatus:'submitted'});
  let reads=0;
  const context=vm.createContext({readRows:name=>{if(name==='Employees'){reads++;return employees;}return rows;}});
  vm.runInContext(source,context);
  vm.runInContext('readAll_ = readRows;',context);
  return {context,employees,reads:()=>reads,list(actor){context.actor=actor;return JSON.parse(vm.runInContext('JSON.stringify(handleListEval_(actor, {quarter:"2026-Q3"}))',context));}};
}
test('evaluator reads employees once even for many evaluations',()=>{
  const f=fixture();
  const result=f.list({asEvaluator:true,asWriter:false,employee:f.employees[0]});
  assert.equal(result.length,60);assert.equal(f.reads(),1);
  assert.deepEqual(result[0].pillarScores,{quality:5});
  assert.deepEqual(result[0].selfAssessment,{});
});
test('writer and admin redaction are preserved',()=>{
  const f=fixture();
  const own=f.list({asWriter:true,asEvaluator:false,employee:f.employees[2]});
  assert.equal(own.length,60);assert.equal(own[0].pillarScores,undefined);
  assert.deepEqual(own[0].selfAssessment,{c:4});assert.equal(f.reads(),0);
  const admin=f.list({isAdmin:true});assert.equal(admin.length,61);
  assert.equal(admin[0].pillarScores,undefined);assert.equal(admin[0].selfAssessment,undefined);
});
test('expanded evaluator scope and unrelated employee exclusion are preserved',()=>{
  const f=fixture();
  assert.equal(f.list({asEvaluator:true,employee:{id:'unrelated'}}).length,0);
  const extra=f.list({asEvaluator:true,employee:{id:'unrelated',evalScopeIds:['outside']}});
  assert.equal(extra.length,1);assert.deepEqual(extra[0].pillarScores,{quality:3});
  assert.deepEqual(extra[0].selfAssessment,{c:3});
  assert.equal(f.list({asEvaluator:true,employee:{id:'unrelated',evalScopeAll:true}}).length,61);
});
module.exports={fixture};
