const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Calc = require('../docs/js/calc.js');

test('browser exposes the Calc interface used by evaluation screens', () => {
  const context = vm.createContext({setTimeout: (fn) => { fn(); },});
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
  const context = vm.createContext({setTimeout: (fn) => { fn(); },API_BASE_URL:'https://example.invalid',fetch:async()=>response});
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

test('read cache deduplicates requests, clones results, expires and isolates accounts', async () => {
  let calls = 0, now = 0;
  const context = vm.createContext({setTimeout: (fn) => { fn(); },Date:{now:()=>now}, fetch:async()=>{ calls++; return {ok:true,json:async()=>({ok:true,data:[{name:'original'}]})}; }, API_BASE_URL:'test'});
  vm.runInContext(fs.readFileSync('docs/js/api.js','utf8'),context);
  const run = (code) => vm.runInContext(code,context);
  const [a,b] = await Promise.all([run("Api.call('listEval',{auth:{code:'a'}})"),run("Api.call('listEval',{auth:{code:'a'}})")]);
  assert.equal(calls,1); a[0].name='changed'; assert.equal(b[0].name,'original');
  assert.equal((await run("Api.call('listEval',{auth:{code:'a'}})"))[0].name,'original');
  assert.equal(calls,1);
  await run("Api.call('listEval',{auth:{code:'b'}})"); assert.equal(calls,2);
  now=15001; await run("Api.call('listEval',{auth:{code:'a'}})"); assert.equal(calls,3);
  await run("Api.call('upsertEval')"); await run("Api.call('listEval',{auth:{code:'a'}})"); assert.equal(calls,5);
  run('Api.clearCache()'); await run("Api.call('listEval',{auth:{code:'a'}})"); assert.equal(calls,6);
});
test('in-flight reads cannot refill cache after invalidation', async () => {
  let finish, calls=0;
  const context=vm.createContext({setTimeout: (fn) => { fn(); },API_BASE_URL:'test', fetch:()=>{ calls++; return new Promise(resolve=>{ finish=()=>resolve({ok:true,json:async()=>({ok:true,data:[]})}); }); }});
  vm.runInContext(fs.readFileSync('docs/js/api.js','utf8'),context);
  const first=vm.runInContext("Api.call('listEval')",context);
  vm.runInContext('Api.clearCache()',context); finish(); await first;
  const second=vm.runInContext("Api.call('listEval')",context); assert.equal(calls,2); finish(); await second;
});
test('team renders before previous-quarter response and keeps table on summary failure', async () => {
  let rejectSummary;
  const slot={isConnected:true,innerHTML:'',querySelector:()=>({})};
  const el={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>slot};
  const context=vm.createContext({setTimeout: (fn) => { fn(); },Store:{currentQuarter:()=> '2026-Q3',quarterOptions:()=>['2026-Q3','2026-Q2']},document:{addEventListener(){}},Api:{call:async(action,{payload}={})=>{
    if(action==='listEmployees') return [{id:'writer',isWriter:true,managerId:'manager',name:'Writer'}];
    if(payload?.quarter==='2026-Q2') return new Promise((_,reject)=>{rejectSummary=reject;});
    return [];
  }},el});
  vm.runInContext(fs.readFileSync('docs/js/main.js','utf8'),context);
  vm.runInContext("App.session={role:'evaluator',code:'test',employee:{id:'manager'}}; App.settings={};",context);
  await vm.runInContext('renderTeamView(el)',context);
  assert.match(el.innerHTML,/Writer/);
  rejectSummary(new Error('HTTP 404'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(el.innerHTML,/Writer/);
  assert.match(slot.innerHTML,/HTTP 404/);
});

test('transient reads and login recover; writes and rejected credentials never retry', async()=>{
  async function scenario(action,responses) {
    let calls=0;
    const context=vm.createContext({API_BASE_URL:'test',setTimeout:fn=>fn(),fetch:async()=>responses[Math.min(calls++,responses.length-1)]});
    vm.runInContext(fs.readFileSync('docs/js/api.js','utf8'),context);
    let error, data;
    try {data=await vm.runInContext(`Api.call('${action}')`,context);} catch(e){error=e;}
    return {calls,error,data};
  }
  const unavailable={ok:false,status:404};
  const success={ok:true,json:async()=>({ok:true,data:[]})};
  assert.equal((await scenario('listEval',[unavailable,success])).calls,2);
  const login=await scenario('login',[unavailable,success]);assert.equal(login.calls,2);assert.equal(login.error,undefined);
  assert.equal((await scenario('upsertEval',[unavailable,success])).calls,1);
  assert.equal((await scenario('login',[{ok:true,json:async()=>({ok:false,error:'invalid credentials'})}])).calls,1);
  assert.equal((await scenario('listEval',[unavailable])).calls,3);
});
test('temporary settings failure keeps the authenticated session',async()=>{
  let cleared=false;
  const app={innerHTML:''};const elements={app,retryBoot:{},exitBoot:{}};
  const context=vm.createContext({Store:{currentQuarter:()=> '2026-Q3',get:()=>({role:'evaluator',code:'test'}),clear:()=>{cleared=true;}},document:{addEventListener(){},getElementById:id=>elements[id]},Api:{call:async()=>{throw Object.assign(new Error('temporary'),{transient:true});}}});
  vm.runInContext(fs.readFileSync('docs/js/main.js','utf8'),context);
  await vm.runInContext('boot()',context);
  assert.equal(cleared,false);assert.match(app.innerHTML,/retryBoot/);
});

test('settings reject health text and malformed payloads, retry then cache only valid settings',async()=>{
 const valid={pillars:[{id:'quality',criteria:[]}],classification:[]};
 let calls=0;const responses=['motem Apps Script server up', {pillars:[]},valid];
 const c=vm.createContext({setTimeout:fn=>fn(),API_BASE_URL:'test',fetch:async()=>({ok:true,json:async()=>({ok:true,data:responses[calls++]})})});
 vm.runInContext(fs.readFileSync('docs/js/api.js','utf8'),c);
 const settings=await vm.runInContext("Api.call('getSettings')",c);
 assert.equal(settings.pillars[0].id,'quality');assert.equal(calls,3);
 await vm.runInContext("Api.call('getSettings')",c);assert.equal(calls,3);
});
test('invalid settings fail clearly instead of reaching settings.pillars.find',async()=>{
 const c=vm.createContext({setTimeout:fn=>fn(),API_BASE_URL:'test',fetch:async()=>({ok:true,json:async()=>({ok:true,data:'server up'})})});
 vm.runInContext(fs.readFileSync('docs/js/api.js','utf8'),c);
 await assert.rejects(vm.runInContext("Api.call('getSettings')",c),/معايير التقييم/);
});
