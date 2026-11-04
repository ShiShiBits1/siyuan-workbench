import {normalizeChecklist} from '../domain/task-checklist.js';
import {createNativeDefinitionStore} from './native-documents.js';

export function templateFields(input={}) {
  const fields={title:input.title??'',category:input.category??'',tags:input.tags??[],priority:input.priority??null,detail:input.detail??''};
  for(const key of ['title','category','detail'])if(typeof fields[key]!=='string'||fields[key].length>(key==='detail'?50000:1000))throw new Error('模板字段格式无效');
  if(!Array.isArray(fields.tags)||fields.tags.length>100||fields.tags.some(v=>typeof v!=='string'||v.length>200))throw new Error('模板标签无效');
  if(fields.priority!==null&&!['urgent','high','normal','low',''].includes(fields.priority))throw new Error('模板优先级无效');
  if (Object.hasOwn(input,'checklist')) fields.checklist=normalizeChecklist(input.checklist).map(step=>({...step,done:false}));
  return structuredClone(fields);
}
export function applyTaskTemplate(current,template,{replace=false}={}) {
  const fields=templateFields(template.fields||template);if(!replace&&Object.keys(fields).some(key=>Array.isArray(current[key])?current[key].length:!!current[key]))throw new Error('当前表单已有内容，请确认后应用模板');
  return {...current,...fields};
}
export function createTaskTemplateRepository({notebookId,post,now}) {
  const store=createNativeDefinitionStore({notebookId,post,now,kind:'task-template',folderName:'任务模板'});
  const upsert=async(input,options)=>{if(typeof input.name!=='string'||!input.name.trim()||input.name.length>200)throw new Error('请填写模板名称');const prior=options?.expectedUpdatedAt!==undefined?await store.get(input.id):null;if(input.archived!==undefined&&typeof input.archived!=='boolean')throw new Error('模板归档状态无效');const draft={...input,name:input.name.trim(),fields:{...prior?.fields,...input.fields,...templateFields({...prior?.fields,...input.fields})},archived:input.archived??prior?.archived??false};const pending=store.upsert(draft,options);input.id=draft.id;return pending;};
  return {get:store.get,list:async({includeArchived=false}={})=>(await store.list()).filter(v=>includeArchived||!v.archived),upsert,archive:async(id,options)=>upsert({...await store.get(id),archived:true},options)};
}
