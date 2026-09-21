const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function context(){const c=vm.createContext({});vm.runInContext(fs.readFileSync('api/Code.gs','utf8'),c);vm.runInContext(fs.readFileSync('docs/js/store.js','utf8'),c);return c;}
test('work quarter agrees in browser and server on all quarter boundaries',()=>{
 const c=context();
 for(const [date,quarter] of Object.entries({'2026-01-01':'2026-Q1','2026-03-31':'2026-Q1','2026-04-01':'2026-Q2','2026-06-30':'2026-Q2','2026-07-01':'2026-Q3','2026-09-30':'2026-Q3','2026-10-01':'2026-Q4','2026-12-31':'2026-Q4','2027-01-01':'2027-Q1','2024-02-29':'2024-Q1'})){
  c.date=date;assert.equal(vm.runInContext('getQuarterFromDate_(date)',c),quarter);assert.equal(vm.runInContext('Store.quarterForWorkDate(date)',c),quarter);
 }
 for(const date of ['',null,'bad','2026-02-29','2026-04-31','2026-13-01']){c.date=date;assert.equal(vm.runInContext('getQuarterFromDate_(date)',c),null);}
});
test('save ignores supplied quarter and moving date resets both quarters',()=>{
 const c=context();
 vm.runInContext(`
 var stored=null, resets=[];
 ownedWorkIds_=()=>({writer:true});
 findOne_=()=>stored;
 upsertRow_=(sheet,row)=>{};
 audit_=()=>{};
 newId=()=> 'new';
 resetWorkLogSubmissionIfNeeded_=(id,q)=>resets.push([id,q]);
 var actor={employee:{name:'Writer'},isAdmin:false};
 `,c);
 let saved=vm.runInContext(`handleUpsertWork_(actor,{row:{employeeId:'writer',quarter:'2026-Q3',date:'2026-04-01'}})`,c);
 assert.equal(saved.quarter,'2026-Q2');
 vm.runInContext(`stored={id:'existing',employeeId:'writer',quarter:'2026-Q3',date:'2026-07-01'};resets=[];`,c);
 saved=vm.runInContext(`handleUpsertWork_(actor,{row:{id:'existing',employeeId:'writer',quarter:'2026-Q3',date:'2026-12-01'}})`,c);
 assert.equal(saved.quarter,'2026-Q4');assert.equal(vm.runInContext('JSON.stringify(resets)',c),'[["writer","2026-Q3"],["writer","2026-Q4"]]');
 assert.throws(()=>vm.runInContext(`handleUpsertWork_(actor,{row:{employeeId:'writer',date:'2026-02-30'}})`,c));
});
