import {mountTaskChecklist} from './task-checklist.js';
import {templateFields} from '../src/task-templates/index.js';
import {mountCategoryPicker} from './category-picker.js';
import {validateRecurrenceRule} from '../src/task-recurrence/schedule.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function businessValue(kind,value){
  const result={name:typeof value.name==='string'?value.name.trim():'',fields:templateFields(value.fields)};
  if(kind==='series'){const rule=validateRecurrenceRule(value.rule);result.rule=Object.fromEntries(['frequency','interval','startDate','time','weekdays','endDate'].map(key=>[key,rule[key]]));result.enabled=value.enabled??true;}
  else result.archived=value.archived??false;
  return result;
}
function stamp(value){const parsed=Date.parse(value);return typeof value==='string'&&Number.isFinite(parsed)&&new Date(parsed).toISOString()===value?parsed:null;}
function matchesAttempt(current,found){
  if(!found||found.id!==current.pendingInput?.id||JSON.stringify(businessValue(current.kind,found))!==JSON.stringify(businessValue(current.kind,current.pendingInput)))return false;
  const updated=stamp(found.updatedAt);if(updated===null)return false;
  const previous=current.kind==='template'?current.row?.updatedAt:null;
  if(previous!==undefined&&previous!==null){const before=stamp(previous);if(before===null||updated<=before)return false;}
  else {const created=stamp(found.createdAt);if(created===null||created>updated)return false;}
  return !current.receiptUpdatedAt||found.updatedAt===current.receiptUpdatedAt;
}
const localDate=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};

export function mountTaskTemplateCenter(container,{templates,recurrence,notebookId,onCreateTask,listCategories,showHeading=true,onRecordChange=()=>{}}){
  let disposed=false,busy=false,generation=0,tab='templates',items=[],series=[],editing=null,lastFailure=null;
  container.innerHTML=`<section class="swtc" aria-label="任务模板与重复计划">${showHeading?'<header><div><h2>任务模板与重复计划</h2><p>复用常用任务，每期工作独立保留。</p></div></header>':''}<nav aria-label="模板中心视图"><button type="button" data-tc="templates" aria-pressed="true">常用模板</button><button type="button" data-tc="series" aria-pressed="false">重复计划</button><button type="button" data-tc="refresh">刷新</button></nav><p class="swtc__error" role="alert" hidden></p><p class="swtc__status" role="status" aria-live="polite"></p><div class="swtc__toolbar"></div><div class="swtc__editor"></div><div class="swtc__list"></div></section>`;
  const root=container.querySelector('.swtc'),list=root.querySelector('.swtc__list'),editor=root.querySelector('.swtc__editor'),error=root.querySelector('.swtc__error'),status=root.querySelector('.swtc__status'),toolbar=root.querySelector('.swtc__toolbar');
  const button=(action,label,id='')=>`<button type="button" data-tc="${action}" data-id="${esc(id)}" ${busy?'disabled':''}>${label}</button>`;
  const setError=message=>{error.textContent=message||'';error.hidden=!message;};
  function draw(){
    if(disposed)return;
    root.querySelectorAll('nav button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tc===tab)));
    toolbar.innerHTML=tab==='templates'?button('new-template','新建模板'):button('new-series','新建重复计划')+button('tick','补齐到期任务');
    root.querySelector('[data-tc="refresh"]').disabled=busy;
    const rows=tab==='templates'?items:series;
    list.innerHTML=rows.length?rows.map(row=>`<article><header><h3>${esc(row.name)}</h3>${tab==='series'?`<span>${row.enabled?'启用中':'已停用'}</span>`:''}</header><p>${esc(row.fields.title)}</p>${row.fields.category?`<small>${esc(row.fields.category)}</small>`:''}${tab==='series'?`<p>每${esc(row.rule.interval||1)}${row.rule.frequency==='weekly'?'周':'天'} ${esc(row.rule.time)}，${esc(row.rule.startDate)}起${row.rule.endDate?'，至'+esc(row.rule.endDate):''}</p><p>最近处理日期：${esc(row.cursor||'尚未生成')}</p>`:''}<footer>${tab==='templates'?button('create','从模板新建任务',row.id)+button('edit','编辑',row.id)+button('from-template-series','设为重复计划',row.id)+button('ask-archive','停用模板',row.id):button(row.enabled?'pause-series':'resume-series',row.enabled?'停用计划':'启用计划',row.id)}</footer></article>`).join(''):`<p class="swtc__empty">${tab==='templates'?'暂无模板。保存常用的新品上架、活动报名等任务字段，下一次直接复用。':'暂无重复计划。按固定日历时间生成独立任务；上一次未完成也会保留新一期。'}</p>`;
  }
  async function read(){const [a,b]=await Promise.all([templates.list(),recurrence.list(notebookId)]);return {items:a,series:b};}
  async function work(operation,success){
    if(disposed||busy)return false;busy=true;lastFailure=null;setError();draw();const token=++generation;
    try{const next=await operation();if(disposed||token!==generation)return false;if(next?.items){items=next.items;series=next.series;}if(success)status.textContent=success;return true;}
    catch(failure){lastFailure=failure;if(!disposed&&token===generation)setError(failure?.message||'操作未确认，请核查后重试。');return false;}
    finally{if(!disposed&&token===generation){busy=false;draw();}}
  }
  function showForm(kind,row=null){
    if(busy||editor.querySelector('form')){setError('请先保存或取消当前草稿。');return;}
    editing={kind,row};const fields=row?.fields||{},isSeries=kind==='series';
    const input=(label,name,value='',type='text',extra='')=>`<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
    editor.innerHTML=`<form class="swtc__form" aria-label="${isSeries?'重复计划':'任务模板'}"><h3>${isSeries?'新建重复计划':row?'编辑模板':'新建模板'}</h3><div class="swtc__grid">${input('名称','name',isSeries?'':row?.name||'','text','required')}${input('任务标题','title',fields.title||'','text','required')}${input('分类','category',fields.category||'')}${input('标签（逗号分隔）','tags',(fields.tags||[]).join(', '))}<label>优先级<select name="priority"><option value="">不设置</option>${[['urgent','紧急'],['high','高'],['normal','普通'],['low','低']].map(([value,label])=>`<option value="${value}" ${fields.priority===value?'selected':''}>${label}</option>`).join('')}</select></label>${isSeries?`<label>重复方式<select name="frequency"><option value="daily">每天</option><option value="weekly">每周（开始日期的星期）</option></select></label>${input('开始日期','startDate',localDate(),'date','required')}${input('生成时间','time','09:00','time','required')}${input('间隔（日或周）','interval',1,'number','min="1" max="52" required')}${input('结束日期（可选）','endDate','','date')}`:''}<label class="swtc__wide">详细内容<textarea name="detail" rows="4">${esc(fields.detail||'')}</textarea></label><div class="swtc__wide" data-template-checklist></div></div>${isSeries?'<p>按固定日历生成独立任务，不会覆盖上一期。仅思源运行时自动检查；关闭期间的到期任务分批补齐。</p>':'<p>模板仅复用常用字段，不复制旧任务的日期、状态、附件或完成记录。</p>'}<footer>${button('cancel','取消')}<button type="submit">${isSeries?'保存计划':'保存模板'}</button></footer></form>`;
    editing.checklist=mountTaskChecklist(editor.querySelector('[data-template-checklist]'),fields.checklist,{template:true});
    if (listCategories) mountCategoryPicker(editor.querySelector('[name="category"]'), () => listCategories('task'));
    editor.querySelector('input')?.focus();
  }
  async function onClick(event){
    const target=event.target.closest('[data-tc]');if(!target||target.disabled||busy)return;const action=target.dataset.tc,id=target.dataset.id;
    if(action==='cancel'){editor.innerHTML='';editing=null;return;}
    if(['reconcile','load-current'].includes(action)&&editing){
      const current=editing,identity=current.pendingInput?.id||current.persistedID||(current.kind==='template'?current.row?.id:null);let loaded=null;
      const ok=await work(async()=>{
        const next=await read();let found=(current.kind==='series'?next.series:next.items).find(row=>row.id===identity);
        if(!found&&action==='load-current'&&current.kind==='template'&&typeof templates.get==='function')found=await templates.get(identity);
        if(!found)throw new Error('尚未查到该保存结果，草稿仍保留；请到原生文档核查，未自动重试。');
        if(action==='reconcile'){
          if(!matchesAttempt(current,found))throw new Error('服务器当前内容或更新时间与本次保存不符，草稿仍保留且未解锁；可继续核查，或确认放弃草稿后加载当前内容。');
        }else{
          businessValue(current.kind,found);
          if(!root.ownerDocument.defaultView?.confirm?.('加载服务器当前内容将放弃这里尚未确认的草稿，是否继续？'))return null;
          loaded=found;
        }
        editor.innerHTML='';editing=null;return next;
      },action==='reconcile'?(current.kind==='template'&&current.row?'已核对本次保存内容与更新时间，保存结果已确认。':'已确认相同定义存在，草稿内容已保留在该记录中。'):null);
      if(ok&&loaded){if(current.kind==='template')showForm('template',loaded);status.textContent='已放弃本地草稿并加载服务器当前内容。';}
      return;
    }
    if(['templates','series'].includes(action)){if(editor.querySelector('form')){setError('请先保存或取消当前草稿。');return;}tab=action;draw();return;}
    if(action==='refresh'){if(editor.querySelector('form')){setError('草稿仍保留，请先保存或取消。');return;}return refresh();}
    if(action==='new-template')return showForm('template');
    if(action==='new-series')return showForm('series');
    const template=items.find(row=>row.id===id),plan=series.find(row=>row.id===id);
    if(action==='edit'&&template)return showForm('template',template);
    if(action==='from-template-series'&&template)return showForm('series',template);
    if(action==='create'&&template){if(editor.querySelector('form')){setError('当前草稿尚未保存。');return;}try{const ok=await onCreateTask?.(structuredClone(template.fields));if(ok===false||!onCreateTask)setError('当前任务草稿尚未保存，请先处理后再从模板新建。');}catch(failure){setError(failure.message);}return;}
    if(action==='ask-archive'&&template){if(editor.querySelector('form')){setError('请先处理当前草稿。');return;}editor.innerHTML=`<section class="swtc__confirm"><h3>停用“${esc(template.name)}”？</h3><p>模板原生文档与已创建任务保留。</p>${button('archive','确认停用',id)}${button('cancel','保留')}</section>`;return;}
    if(action==='archive'&&template){if(await work(async()=>{await templates.archive(id,{expectedUpdatedAt:template.updatedAt});return read();},'模板已停用，原文档保留。'))editor.innerHTML='';return;}
    if(['pause-series','resume-series'].includes(action)&&plan)return work(async()=>{await recurrence.updateEnabled(notebookId,id,action==='resume-series',{expectedUpdatedAt:plan.updatedAt});return read();},'计划状态已保存。');
    if(action==='tick'){let more=false;const ok=await work(async()=>{const result=await recurrence.tick({notebookId});if(result?.errors?.length)throw new Error('部分到期任务未确认，请核查后重试。');more=Boolean(result?.hasMore);await onRecordChange();return read();},'已检查到期计划；未完成的任务保持原样。');if(ok&&more)status.textContent='本批已完成，仍有历史到期任务，可再次补齐；未完成任务保留。';return;}
  }
  async function onSubmit(event){
    const form=event.target;if(!form.matches('.swtc__form'))return;event.preventDefault();if(!editing||busy||editing.needsReconcile)return;
    const values=Object.fromEntries(new FormData(form)),fields={title:values.title,category:values.category||null,tags:values.tags.split(/[,，]/).map(s=>s.trim()).filter(Boolean),priority:values.priority||null,detail:values.detail||''},current=editing;
    if(current.checklist.changed||current.row?.fields?.checklist)fields.checklist=current.checklist.getValue();
    const controls=[...form.querySelectorAll('input,select,textarea,button')],disabled=controls.map(el=>el.disabled);controls.forEach(el=>el.disabled=true);
    current.pendingInput ||= {...(current.kind==='template'&&current.row?{id:current.row.id}:{}),name:values.name,fields};Object.assign(current.pendingInput,{name:values.name,fields});
    let writeConfirmed=false;
    const ok=await work(async()=>{
      try{if(current.kind==='series'){const weekday=new Date(values.startDate+'T12:00:00').getDay();Object.assign(current.pendingInput,{rule:{frequency:values.frequency,interval:Number(values.interval),startDate:values.startDate,time:values.time,weekdays:values.frequency==='weekly'?[weekday]:[],endDate:values.endDate||null}});const saved=await recurrence.create(notebookId,current.pendingInput);current.persistedID=saved?.id||current.pendingInput.id;current.receiptUpdatedAt=saved?.updatedAt;}
      else {const saved=await templates.upsert(current.pendingInput,{expectedUpdatedAt:current.row?.updatedAt});current.persistedID=saved?.id||current.pendingInput.id;current.receiptUpdatedAt=saved?.updatedAt;}
      writeConfirmed=true;return await read();}catch(failure){if(writeConfirmed)failure.commitState='committed';throw failure;}
    },current.kind==='series'?'重复计划已保存。':'模板已保存。');
    if(disposed)return;if(ok){editor.innerHTML='';editing=null;}else if(['unknown','committed'].includes(lastFailure?.commitState||lastFailure?.data?.commitState)){current.needsReconcile=true;const host=container.ownerDocument.createElement('div');host.innerHTML=button('reconcile','核查保存结果')+button('load-current','加载当前（放弃草稿）')+button('cancel','关闭草稿（不撤销保存）');form.appendChild(host);setError('保存结果需要核查，已锁定重复提交。'+(lastFailure?.message||''));}else controls.forEach((el,i)=>el.disabled=disabled[i]);
  }
  const refresh=()=>editor.querySelector('form')?Promise.resolve(false):work(read);
  root.addEventListener('click',onClick);root.addEventListener('submit',onSubmit);void refresh();
  const cleanup=()=>{disposed=true;generation++;root.removeEventListener('click',onClick);root.removeEventListener('submit',onSubmit);container.innerHTML='';};cleanup.refresh=refresh;return cleanup;
}
