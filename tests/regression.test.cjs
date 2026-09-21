const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Calc = require('../docs/js/calc.js');

test('browser exposes the Calc interface used by evaluation screens', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync('docs/js/calc.js', 'utf8'), context);
  for (const method of ['computeMetrics', 'computeFullEvaluation', 'scoreFromBand', 'suggestBands']) {
    assert.equal(vm.runInContext(`typeof Calc.${method}`, context), 'function');
  }
});
test('bands support both directions and reject invalid anchors', () => {
  assert.equal(Calc.scoreFromBand(75, {1: 0, 3: 50, 5: 100}, true), 4);
  assert.equal(Calc.scoreFromBand(1, {1: 4, 3: 2, 5: 0}, false), 4);
  for (const value of [null, '', NaN, Infinity, 'bad']) assert.equal(Calc.scoreFromBand(value, {1: 0, 3: 50, 5: 100}, true), null);
  assert.equal(Calc.scoreFromBand(0, {1: 0, 3: 0, 5: 0}, true), null);
});
test('metrics use work rows, and quality respects revision weights', () => {
  const rows = [{id:'a', delivered:true, onTime:true, contentRevisionRounds:2, workType:'creative'}, {id:'b', delivered:false, isRevision:true, workType:'formal'}];
  assert.deepEqual(Calc.computeMetrics(rows), {avgContentRevisionRounds:2, onTimeRate:100, taskCompletionRate:50});
  const result = Calc.computeQualityPillar({criteria:[{id:'c', weightCreative:100, weightFormal:100}]}, {a:{c:5}, b:{c:1}}, ['a','b'], 'general', rows, 0.5);
  assert.ok(Math.abs(result.pillarScore - 11/3) < 1e-10);
});
test('full evaluation uses level weights and configured classification', () => {
  const settings = {pillars:[{id:'p', weightWriter:100, weightSenior:80, criteria:[{id:'c',weight:100}]},{id:'leadership',weightWriter:0,weightSenior:20,criteria:[{id:'l',weight:100}]}], classification:[{min:4,max:5,label:'configured'}]};
  const input = {p:{criteriaScores:{c:4}}};
  assert.equal(Calc.computeFullEvaluation(settings,{level:'writer'},input,[]).totalScore,4);
  assert.equal(Calc.computeFullEvaluation(settings,{level:'writer'},input,[]).classification,'configured');
  assert.equal(Calc.computeFullEvaluation(settings,{level:'senior'},input,[]).totalScore,null);
  for (const c of ['', 'bad', Infinity, 6]) assert.equal(Calc.computeFlatPillar(settings.pillars[0],{c},'writer').pillarScore,null);
  assert.equal(Calc.computeRatioPillar({criteria:[{id:'c',type:'rubric',weight:100}]},{},{c:''}).pillarScore,null);
});
async function api(response, action='listEval') {
  const context = vm.createContext({API_BASE_URL:'https://example.invalid',fetch:async()=>response});
  vm.runInContext(fs.readFileSync('docs/js/api.js','utf8'),context);
  return vm.runInContext(`Api.call('${action}')`,context);
}
test('API distinguishes unavailable service, invalid lists and genuine empty lists', async () => {
  await assert.rejects(api({ok:false,status:404}), /HTTP 404/);
  await assert.rejects(api({ok:true,json:async()=>null}), /صيغة البيانات/);
  await assert.rejects(api({ok:true,json:async()=>({ok:true,data:{}})}), /استجابة الخادم غير صالحة/);
  await assert.rejects(api({ok:true,json:async()=>({ok:false,error:'denied'})}), /denied/);
  assert.equal((await api({ok:true,json:async()=>({ok:true,data:[]})})).length,0);
});
