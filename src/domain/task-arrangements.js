import {TASK_PRIORITIES} from './workbench.js';

const clone=value=>structuredClone(value);
const reject=message=>{throw Object.assign(new Error(message),{commitState:'none'});};
const dayText=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
let serviceSequence=0;
function task(record,id){if(record?.kind!=='task'||record.id!==id||!record.updatedAt)reject('任务身份或版本无效，请刷新');return record;}

/** Move the start to a local calendar day, retaining clock precision and duration. */
export function buildTaskDatePatch(record,targetDate) {
  if(record?.kind!=='task')reject('只有任务支持拖拽改期');
  if(typeof targetDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(targetDate))reject('改期日期无效');
  const [year,month,date]=targetDate.split('-').map(Number),target=new Date(year,month-1,date,12);
  if(dayText(target)!==targetDate)reject('改期日期无效');
  const anchor=record.startAt||record.endAt;
  if(!anchor){target.setHours(9,0,0,0);return {startAt:target.toISOString()};}
  const original=new Date(anchor);if(!Number.isFinite(original.getTime()))reject('原任务时间无效');
  const moved=new Date(original);moved.setFullYear(year,month-1,date);
  // A nonexistent DST wall time must be reviewed instead of silently normalized.
  if(dayText(moved)!==targetDate||moved.getHours()!==original.getHours()||moved.getMinutes()!==original.getMinutes())reject('目标日期的本地时间不可用，请手动安排');
  const delta=moved.getTime()-original.getTime(),patch={};
  for(const field of ['startAt','endAt'])if(record[field]){
    const value=Date.parse(record[field]);if(!Number.isFinite(value))reject('原任务时间无效');
    patch[field]=delta===0?record[field]:new Date(value+delta).toISOString();
  }
  return patch;
}

/** In-memory, one-use plans. All persisted writes remain in the scoped repository. */
export function createTaskArrangementService({getTask,patchTask,maxBatch=20,isDisposed=()=>false}) {
  const plans=new Map(),undos=new Map(),scope=++serviceSequence;let sequence=0,busy=false,disposed=false;
  const remember=(map,key,value)=>{map.set(key,value);if(map.size>20)map.delete(map.keys().next().value);};
  const available=()=>{if(disposed||isDisposed())reject('当前工作台已关闭，请重新打开');};
  async function read(id){available();const result=task(await getTask(id),id);available();return result;}
  async function exclusive(operation){available();if(busy)reject('安排操作尚未结束，请等待');busy=true;try{return await operation();}finally{busy=false;}}
  function batchPatch(patch){
    if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length||Object.keys(patch).some(key=>!['category','priority'].includes(key)))reject('批量修改只支持分类或优先级');
    if('category'in patch&&(typeof patch.category!=='string'||patch.category.length>200))reject('分类格式无效');
    if('priority'in patch&&patch.priority!==null&&!TASK_PRIORITIES.includes(patch.priority))reject('优先级无效');
    return clone(patch);
  }
  async function preview(ids,input){
    available();const patch=batchPatch(input);
    if(!Array.isArray(ids)||!ids.length||ids.length>Math.min(20,maxBatch)||ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)reject('请选择1至20条不重复的任务');
    const items=[];for(const id of ids){const before=clone(await read(id));items.push({id,title:before.title,before,patch:clone(patch)});}
    const token=`batch-${scope}-${++sequence}`,plan={token,kind:'batch',items};remember(plans,token,plan);return clone(plan);
  }
  async function execute(input){return exclusive(async()=>{
    const token=typeof input==='string'?input:input?.token,plan=plans.get(token);
    if(!plan)reject('批量预览已失效或已执行，请重新预览');plans.delete(token);
    const results=[];let stopped=false;
    for(const item of plan.items){
      if(stopped){results.push({id:item.id,state:'not-run',message:'前一项未确认，未执行'});continue;}
      try{
        const current=await read(item.id);if(current.updatedAt!==item.before.updatedAt)reject('任务在预览后已改变，请重新预览');
        const record=task(await patchTask(item.id,clone(item.patch),{expectedUpdatedAt:current.updatedAt}),item.id);
        results.push({id:item.id,state:'saved',record,commitState:'committed'});
      }catch(error){const commitState=error?.commitState??error?.data?.commitState??'unknown';results.push({id:item.id,state:commitState==='none'?'failed':'unknown',commitState,message:error.message||'结果未确认'});stopped=true;}
    }
    return {results,stopped};
  });}
  async function move(id,date,{expectedUpdatedAt}={}){return exclusive(async()=>{
    const before=clone(await read(id));if(expectedUpdatedAt!==undefined&&before.updatedAt!==expectedUpdatedAt)reject('任务在确认期间已改变，请重新预览');
    const patch=buildTaskDatePatch(before,date),record=task(await patchTask(id,clone(patch),{expectedUpdatedAt:before.updatedAt}),id);
    const undoToken=`move-${scope}-${++sequence}`;remember(undos,undoToken,{id,before,after:clone(record),fields:Object.keys(patch)});return {record,undoToken};
  });}
  async function undo(token){return exclusive(async()=>{
    const item=undos.get(token);if(!item)reject('本次改期已撤销或记录已失效');
    const current=await read(item.id);
    if(current.updatedAt!==item.after.updatedAt||item.fields.some(field=>current[field]!==item.after[field]))reject('任务在改期后已被编辑，未撤销，请刷新后手动安排');
    // Consume before submission: an uncertain response must never replay a write.
    undos.delete(token);
    const patch=Object.fromEntries(item.fields.map(field=>[field,item.before[field]??null]));
    return task(await patchTask(item.id,patch,{expectedUpdatedAt:current.updatedAt}),item.id);
  });}
  return {preview,execute,move,undo,dispose(){disposed=true;plans.clear();undos.clear();}};
}
