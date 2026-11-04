import {normalizeSearchFilter} from './unified-search.js';
const clone=value=>structuredClone(value);
const fail=(message,commitState='none')=>Object.assign(new Error(message),{commitState});
function stateFrom(raw){
 if(raw===undefined||raw==='')return {version:1,views:[]};
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.version!==1||!Array.isArray(raw.views)||raw.views.length>50)throw fail('保存视图文件损坏，未重置，请检查原文件');
 const ids=new Set();for(const view of raw.views){if(!view||typeof view!=='object'||typeof view.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(view.id)||ids.has(view.id)||typeof view.name!=='string'||!view.name.trim()||view.name.length>100||!view.criteria||typeof view.criteria!=='object'||Array.isArray(view.criteria))throw fail('保存视图数据无效，未覆盖原文件');ids.add(view.id);normalizeSearchFilter(view.criteria);}
 return clone(raw);
}
export function createSavedSearchStore({load,save,now=()=>new Date(),randomUUID=()=>globalThis.crypto.randomUUID()}) {
 let state=null,blocked=false,pending=Promise.resolve();
 const enqueue=op=>{const result=pending.then(op);pending=result.catch(()=>{});return result;};
 async function read(){return stateFrom(await load());}
 async function reload(){return enqueue(async()=>{try{state=await read();blocked=false;return clone(state.views);}catch(error){blocked=true;throw error;}});}
 async function update(operation){return enqueue(async()=>{
  if(blocked)throw fail('保存结果待核查，请先重新加载视图；未自动重放');
  let current;try{current=await read();}catch(error){blocked=true;throw error;}
  const next=clone(current),result=operation(next);
  try{const response=await save(next);if(response?.code!==0)throw fail('保存视图结果未确认，请重新加载核查','unknown');}
  catch(error){blocked=true;throw fail(error.message||'保存视图结果未确认','unknown');}
  try{const verified=await read();if(JSON.stringify(verified)!==JSON.stringify(next))throw Error('保存后内容与提交内容不一致');state=verified;return clone(result);}
  catch(error){blocked=true;throw fail('保存已提交，但读回未确认，请重新加载核查：'+error.message,'committed');}
 });}
 return {reload,list(){if(!state)throw fail('请先加载保存视图');return clone(state.views);},
  upsert(input){
   if(!input||typeof input.name!=='string'||!input.name.trim()||input.name.length>100)return Promise.reject(fail('视图名称不能为空或超过100字符'));
   let criteria;try{criteria=normalizeSearchFilter(input.criteria);}catch(error){return Promise.reject(error);}
   return update(next=>{
    const existing=input.id?next.views.find(view=>view.id===input.id):null;
    if(input.id&&!existing)throw fail('视图已不存在，请重新加载');
    if(!existing&&next.views.length>=50)throw fail('最多保存50个视图');
    const stamp=new Date(now()).toISOString(),id=existing?.id||randomUUID();if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(id)||(!existing&&next.views.some(view=>view.id===id)))throw fail('新视图标识无效或重复');
    const record={...existing,id,name:input.name.trim(),criteria:{...existing?.criteria,...criteria},createdAt:existing?.createdAt||stamp,updatedAt:stamp};next.views=next.views.filter(view=>view.id!==id);next.views.push(record);return record;
   });
  },remove(id){return update(next=>{if(typeof id!=='string'||!next.views.some(view=>view.id===id))throw fail('视图已不存在，请重新加载');next.views=next.views.filter(view=>view.id!==id);return {id,deleted:true};});}
 };
}
