import {createNativeDefinitionStore} from '../task-templates/native-documents.js';
import {templateFields} from '../task-templates/index.js';
import {validateRecurrenceRule,occurrenceDates,occurrenceDateTime,occurrenceID} from './schedule.js';
export {validateRecurrenceRule,occurrenceDates,occurrenceDateTime,occurrenceID} from './schedule.js';

export function createTaskRecurrenceService({post,repositoryFactory,runWrite=(_book,fn)=>fn(),now=()=>new Date(),onChanged=()=>{},isDisposed=()=>false,maxCatchUp=7}){
  if(typeof post!=='function'||typeof repositoryFactory!=='function'||!Number.isInteger(maxCatchUp)||maxCatchUp<1||maxCatchUp>100)throw new Error('重复任务服务参数无效');
  let disposed=false;const active=new Set();
  const store=book=>createNativeDefinitionStore({notebookId:book,post,kind:'task-series',folderName:'重复计划',now});
  const valid=()=>{if(disposed||isDisposed())throw new Error('重复任务服务已停止');};
  const guarded=(book,fn)=>{valid();return runWrite(book,async()=>{valid();return fn();});};
  async function create(book,input){return guarded(book,async()=>{const fields=templateFields(input.fields);if(!fields.title.trim())throw new Error('请填写重复任务标题');if(typeof input.name!=='string'||!input.name.trim()||input.name.length>200)throw new Error('请填写重复计划名称');const draft={...input,name:input.name.trim(),fields,rule:validateRecurrenceRule(input.rule),enabled:true,cursor:null};const pending=store(book).upsert(draft);input.id=draft.id;return pending;});}
  async function list(book){valid();return store(book).list();}
  async function updateEnabled(book,id,enabled,{expectedUpdatedAt}={}){if(typeof enabled!=='boolean')throw new Error('启用状态无效');return guarded(book,async()=>{const current=await store(book).get(id);if(expectedUpdatedAt===undefined||current.updatedAt!==expectedUpdatedAt)throw new Error('计划已变化，请重新加载');return store(book).upsert({...current,enabled},{expectedUpdatedAt});});}
  async function tick({notebookId:book}){
    valid();if(active.has(book))return {generated:[],hasMore:false,errors:[],busy:true};active.add(book);
    try{return await guarded(book,async()=>{
      const generated=[],errors=[];let hasMore=false;const plans=await store(book).list();let remaining=maxCatchUp;
      for(let series of plans){valid();if(series.enabled!==true)continue;try{
        if(remaining<=0){hasMore=true;break;}
        const dates=occurrenceDates(series.rule,{after:series.cursor,now:now(),limit:remaining});hasMore ||= dates.hasMore;
        for(const date of dates.dates){valid();const id=occurrenceID(series.id,date),repository=repositoryFactory(book),query=await post('/api/query/sql',{mode:'readonly',stmt:`SELECT id FROM blocks WHERE id='${id}' LIMIT 1`});if(query?.code!==0||!Array.isArray(query.data))throw new Error('期次存在状态无法确认');
          let saved;if(query.data.length){saved=await repository.get(id);}
          else{const fields=templateFields(series.fields);saved=await repository.create({...fields,id,docId:id,kind:'task',status:'todo',attachmentPaths:[],startAt:occurrenceDateTime(date,series.rule.time).toISOString(),endAt:null,reminderAt:null,recurrenceOccurrence:{seriesId:series.id,date}});}
          if(saved?.id!==id||saved.recurrenceOccurrence?.seriesId!==series.id||saved.recurrenceOccurrence.date!==date)throw new Error('期次ID与其它记录冲突，未覆盖');
          const flushed=await post('/api/sqlite/flushTransaction',{});if(flushed?.code!==0)throw new Error('期次已创建但索引同步未确认，需核查');valid();
          series=await store(book).upsert({...series,cursor:date},{expectedUpdatedAt:series.updatedAt});generated.push({id,date,seriesId:series.id});remaining--;
        }
      }catch(error){errors.push({seriesId:series.id,message:error.message,commitState:error.commitState||'unknown'});}}
      if(generated.length&&!disposed&&!isDisposed()){try{await onChanged({notebookId:book,generated});}catch{/* the native records are already committed */}}
      return {generated,hasMore,errors};
    });}finally{active.delete(book);}
  }
  return {create,list,updateEnabled,tick,dispose(){disposed=true;}};
}
