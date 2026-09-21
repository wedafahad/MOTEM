const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
test('document quarter correction preserves file, upload date and approval; enforces scope',()=>{
 const original={id:'doc',employeeId:'sarah',quarter:null,status:'approved',driveFileId:'file',driveUrl:'link',uploadedAt:'2026-08-29T12:24:33Z',reviewedBy:'reviewer'};
 let saved;
 const c=vm.createContext({original,save:row=>{saved=row;}});vm.runInContext(fs.readFileSync('api/Code.gs','utf8'),c);
 vm.runInContext('findOne_=()=>original;upsertRow_=(sheet,row)=>save(row);audit_=()=>{};evaluatesEmployee_=(actor,id)=>actor.employee.id === "manager";',c);
 vm.runInContext('handleSetDocumentQuarter_({employee:{id:"manager",name:"Manager"}},{id:"doc",quarter:"2026-Q2"})',c);
 assert.equal(saved.quarter,'2026-Q2');for(const key of ['status','driveFileId','driveUrl','uploadedAt','reviewedBy'])assert.equal(saved[key],original[key]);
 assert.throws(()=>vm.runInContext('handleSetDocumentQuarter_({employee:{id:"other"}},{id:"doc",quarter:"2026-Q2"})',c));
 assert.throws(()=>vm.runInContext('handleSetDocumentQuarter_({employee:{id:"manager"}},{id:"doc",quarter:"Q2-2026"})',c));
 vm.runInContext('handleSetDocumentQuarter_({asWriter:true,employee:{id:"sarah",name:"Sarah"}},{id:"doc",quarter:"2026-Q2"})',c);
});
