import {mountTaskBatchEditor} from './task-batch-editor.js';
import {checklistSummary} from './task-checklist.js';
import {filterTasks, weekStart, weekDays, recordsForDay,getTaskQuadrant} from '../src/domain/planner.js';

const labels={todo:'待办',in_progress:'进行中',done:'已完成'};
const quadrants={'important-urgent':['重要且紧急','优先处理'],'important-later':['重要不紧急','安排专门时间'],'urgent-only':['不重要但紧急','尽快处理或协作'],later:['不重要不紧急','留待合适时间']};
const priorities={urgent:'紧急',high:'高',normal:'普通',low:'低'};
const views={all:'全部',today:'今日',overdue:'已逾期',next7:'未来七天',unscheduled:'待安排',completed:'已完成'};
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const localDate=value=>{const d=new Date(value);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const dateInput=value=>{if(!value)return '';const d=new Date(value);return `${localDate(d)}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;};
const displayDate=value=>value?dateInput(value).replace('T',' '):'未设置';

/** A task planner with stable search/editor DOM and API-confirmed mutations. */
export function mountPlanner(container,options={}) {
  let tasks=[],events=[],disposed=false,generation=0,loading=false,loaded=false,busy=false,needsReconcile=false;
  const originalTimes=new WeakMap();
  const selected=new Set();let batchEditor=null;
  const now=()=>typeof options.now==='function'?options.now():options.now??new Date();
  let mode='list',view='all',anchor=localDate(now()),draggedId=null;
  container.innerHTML=`<section class="swp" aria-label="任务中心与周计划"><header class="swp__head"><div data-workbench-page-intro><h2>任务中心</h2><p>把待办排进这一周。</p></div><div class="swp__head-actions"><button type="button" data-planner-action="clear">清除筛选</button><button type="button" data-planner-action="refresh">刷新</button></div></header>
    <nav class="swp__views" aria-label="任务范围">${Object.entries(views).map(([key,label])=>`<button type="button" data-planner-view="${key}" aria-pressed="${key==='all'}">${label}</button>`).join('')}</nav>
    <div class="swp__tools"><label class="swp__search">搜索任务<input type="search" aria-label="搜索任务标题或详情" placeholder="搜索标题或详情"></label><label>分类<select data-planner-filter="category" aria-label="筛选任务分类"><option value="">全部分类</option></select></label><label>标签<select data-planner-filter="tag" aria-label="筛选任务标签"><option value="">全部标签</option></select></label><label>优先级<select data-planner-filter="priority" aria-label="筛选任务优先级"><option value="">全部优先级</option>${Object.entries(priorities).map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select></label><label>状态<select data-planner-filter="status" aria-label="筛选任务状态"><option value="">全部状态</option>${Object.entries(labels).map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select></label></div>
    <div class="swp__viewbar"><p class="swp__summary" role="status" aria-live="polite"></p><label><input type="checkbox" class="swp__unfinished" aria-label="仅未完成">仅未完成</label><div aria-label="任务显示方式">${[['list','列表'],['board','看板'],['quadrant','四象限'],['week','周计划']].map(([key,label])=>`<button type="button" data-planner-mode="${key}" aria-pressed="${key==='list'}">${label}</button>`).join('')}</div></div>
    <div class="swp__batch-actions"></div><div class="swp__batch-host"></div><p class="swp__error" role="alert" hidden></p><div class="swp__editor"></div><div class="swp__delete-host"></div><div class="swp__content"></div></section>`;
  const root=container.querySelector('.swp'),search=root.querySelector('[type="search"]');
  const filters=Object.fromEntries([...root.querySelectorAll('[data-planner-filter]')].map(node=>[node.dataset.plannerFilter,node]));
  const error=root.querySelector('.swp__error'),editor=root.querySelector('.swp__editor'),content=root.querySelector('.swp__content'),summary=root.querySelector('.swp__summary');
  const deletion=root.querySelector('.swp__delete-host');
  const showError=message=>{error.textContent=message||'';error.hidden=!message;};
  const orderKey=options.notebookId?'siyuan-workbench:task-order:'+options.notebookId:null;
  let orders={board:[],quadrant:[]};
  try {
    const saved=JSON.parse(container.ownerDocument.defaultView?.localStorage?.getItem(orderKey));
    if(orderKey&&saved&&typeof saved==='object')for(const key of ['board','quadrant'])if(Array.isArray(saved[key]))orders[key]=saved[key].filter(id=>typeof id==='string').slice(0,10000);
  } catch { /* Ordering remains available for this session. */ }
  function saveOrder() {
    if(!orderKey)return;
    try { container.ownerDocument.defaultView.localStorage.setItem(orderKey,JSON.stringify(orders)); }
    catch { showError('任务顺序仅保留在本次会话中，本机存储不可用。'); }
  }
  function lane(task) { return mode==='board'?task.status:getTaskQuadrant(task,now()); }
  function sorted(shown) {
    if(!orders[mode]?.length)return shown;
    const rank=new Map(orders[mode].map((id,index)=>[id,index]));
    return [...shown].sort((a,b)=>(rank.get(a.id)??Infinity)-(rank.get(b.id)??Infinity));
  }
  function reorder(id,targetId,after=false) {
    const ids=sorted(tasks).map(task=>task.id).filter(item=>item!==id);
    let index=targetId?ids.indexOf(targetId):-1;
    if(index<0)index=ids.length;
    else if(after)index++;
    ids.splice(index,0,id);
    orders[mode]=ids;
    saveOrder();
    render();
  }
  function moveControl(task) {
    if(!['board','quadrant'].includes(mode))return '';
    const targets=mode==='board'?labels:Object.fromEntries(Object.entries(quadrants).map(([key,[label]])=>[key,label]));
    return `<div class="swp__move"><label>移到<select data-task-move="${escape(task.id)}" aria-label="移动任务：${escape(task.title)}" ${canMove()?'':'disabled'}>
      ${Object.entries(targets).map(([key,label])=>`<option value="${key}" ${lane(task)===key?'selected':''}>${label}</option>`).join('')}
      </select></label><button type="button" data-planner-action="move-up" data-record-id="${escape(task.id)}" ${canMove()?'':'disabled'}>上移</button>
      <button type="button" data-planner-action="move-down" data-record-id="${escape(task.id)}" ${canMove()?'':'disabled'}>下移</button>
      ${task.quadrantOverride?`<button type="button" data-planner-action="automatic-quadrant" data-record-id="${escape(task.id)}" ${canMove()?'':'disabled'}>恢复自动象限</button>`:''}</div>`;
  }
  function updateChoices() {
    for(const [name,values] of [['category',tasks.map(t=>t.category)],['tag',tasks.flatMap(t=>t.tags||[])]]) {
      const select=filters[name],previous=select.value,set=new Set(values.filter(Boolean));if(previous)set.add(previous);
      select.innerHTML=`<option value="">全部${name==='category'?'分类':'标签'}</option>`+[...set].sort().map(value=>`<option value="${escape(value)}">${escape(value)}</option>`).join('');select.value=previous;
    }
  }
  function filtered() {return filterTasks(tasks,{view,query:search.value,...Object.fromEntries(Object.entries(filters).map(([key,node])=>[key,node.value]))},now()).filter(task=>!root.querySelector('.swp__unfinished').checked||task.status!=='done');}
  function canMove() { return !disposed && !busy && !loading && !needsReconcile && !batchEditor && !editor.firstChild && !deletion.firstChild; }
  function card(task,compact=false) {
    const status=Object.hasOwn(labels,task.status)?task.status:'todo';
    return `<article class="swp__task" data-planner-id="${escape(task.id)}" data-task-status="${status}"${['board','quadrant'].includes(mode)&&canMove()?' draggable="true"':''}><div class="swp__task-head">${options.previewTaskBatch?`<input type="checkbox" data-planner-select="${escape(task.id)}" aria-label="选择任务：${escape(task.title)}" ${selected.has(task.id)?'checked':''} ${busy||needsReconcile||batchEditor?'disabled':''}>`:''}<button type="button" class="swp__title" data-planner-action="open" data-record-id="${escape(task.id)}">${escape(task.title)}</button><span class="swp__status-chip">${labels[status]}</span><span class="swp__priority">${escape(priorities[task.priority]||'')}</span></div>${checklistSummary(task)?`<p class="swp__checklist-summary">${escape(checklistSummary(task))}</p>`:''}${task.quadrantOverride?'<span class="swp__manual-quadrant">手动象限</span>':''}<p class="swp__meta">${escape(task.category||'未分类')} ${escape((task.tags||[]).map(t=>'#'+t).join(' '))}</p>${!compact?`<p class="swp__time">${task.startAt?'开始 '+escape(displayDate(task.startAt)):''}${task.endAt?' · 截止 '+escape(displayDate(task.endAt)):''}${!task.startAt&&!task.endAt?'待安排':''}</p>`:''}${moveControl(task)}<div class="swp__task-actions">${Object.entries(labels).filter(([key])=>key!==status).map(([key,label])=>`<button type="button" data-planner-action="status" data-record-id="${escape(task.id)}" data-status="${key}" ${busy||needsReconcile?'disabled':''}>${label==='已完成'?'完成任务':label==='待办'?'恢复待办':'开始处理'}</button>`).join('')}<details class="swp__more"><summary>更多操作</summary><div class="swp__more-actions">${options.onDelegateTask?`<button type="button" data-planner-action="delegate" data-record-id="${escape(task.id)}">交给 Agent</button>`:''}<button type="button" data-planner-action="edit" data-record-id="${escape(task.id)}" ${busy||needsReconcile?'disabled':''}>调整</button>${options.deleteTask?`<button type="button" class="swp__danger" data-planner-action="delete" data-record-id="${escape(task.id)}" aria-label="删除任务：${escape(task.title)}" ${busy||needsReconcile?'disabled':''}>删除</button>`:''}${options.onFocusTask?`<button type="button" data-planner-action="focus" data-record-id="${escape(task.id)}">专注</button>`:''}</div></details></div></article>`;
  }
  function render() {
    if(disposed||draggedId)return;
    const scroll=content.scrollLeft;
    const shown=sorted(filtered());const visible=new Set(shown.map(task=>task.id));for(const id of selected)if(!visible.has(id))selected.delete(id);
    root.querySelector('.swp__batch-actions').innerHTML=options.previewTaskBatch?`<span>已选 ${selected.size} 项（最多20项）</span><button type="button" data-planner-action="select-visible" ${busy||batchEditor?'disabled':''}>选择当前结果</button><button type="button" data-planner-action="clear-selection" ${busy||batchEditor?'disabled':''}>清空选择</button><button type="button" data-planner-action="batch" ${!selected.size||busy||needsReconcile||batchEditor?'disabled':''}>批量分类与优先级</button>`:'';
    summary.textContent=loading?'正在读取任务…':`显示 ${shown.length} / ${tasks.length} 项任务`;
    root.setAttribute('aria-busy',String(loading));
    root.querySelectorAll('[data-planner-mode]').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.plannerMode===mode)));
    root.querySelectorAll('[data-planner-view]').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.plannerView===view)));
    if(mode==='week') {
      const days=weekDays(anchor),start=weekStart(anchor);
      content.innerHTML=`<header class="swp__week-nav"><strong>${escape(start)} — ${escape(days[6])}</strong><div><button type="button" data-planner-action="prev-week" aria-label="上一周">‹</button><button type="button" data-planner-action="this-week">本周</button><button type="button" data-planner-action="next-week" aria-label="下一周">›</button></div></header><div class="swp__week">${days.map((day,index)=>`<section class="swp__day" aria-label="${escape(day)}"><h3>周${'一二三四五六日'[index]} <time>${escape(day.slice(5))}</time></h3>${recordsForDay(shown,day).map(task=>card(task,true)).join('')}${recordsForDay(events,day).map(event=>`<article class="swp__event"><span>日程 ${escape(event.startAt?dateInput(event.startAt).slice(11):'时间未定')}</span><button type="button" data-planner-action="open" data-record-id="${escape(event.id)}">${escape(event.title)}</button></article>`).join('')}</section>`).join('')}</div><section class="swp__unscheduled"><h3>待安排</h3>${shown.filter(t=>t.status!=='done'&&!t.startAt&&!t.endAt).map(task=>card(task,true)).join('')||'<p>没有待安排任务</p>'}</section>`;
    } else if(mode==='quadrant') {
      content.innerHTML=`<p class="swp__quadrant-rule">自动归类：高或紧急优先级为重要；紧急优先级、逾期或 24 小时内截止为紧急。拖动仅设置手动象限，优先级和日期保留；可恢复自动象限。</p><div class="swp__quadrants">${Object.entries(quadrants).map(([key,[title,hint]])=>{const group=shown.filter(task=>getTaskQuadrant(task,now())===key);return `<section class="swp__quadrant" data-quadrant="${key}" data-task-drop="${key}"><header><h3>${title} <span>${group.length}</span></h3><small>${hint}</small></header>${group.map(task=>card(task)).join('')||'<p class="swp__empty-column">暂无任务</p>'}</section>`;}).join('')}</div>`;
    } else if(mode==='board') {
      content.innerHTML=`<div class="swp__board">${Object.entries(labels).map(([key,label])=>`<section class="swp__column" data-task-drop="${key}" aria-label="${label}看板"><h3>${label}<span>${shown.filter(t=>t.status===key).length}</span></h3>${shown.filter(t=>t.status===key).map(t=>card(t)).join('')||'<p class="swp__empty-column">暂无任务</p>'}</section>`).join('')}</div>`;
    } else content.innerHTML=shown.length?shown.map(task=>card(task)).join(''):`<div class="swp__empty"><strong>${loading?'正在读取任务':!loaded?'任务暂未加载':tasks.length?'没有符合条件的任务':'还没有工作台任务'}</strong><p>${tasks.length?'调整任务范围或筛选条件。':'可回到今日工作新增任务。'}</p></div>`;
    content.scrollLeft=scroll;
  }
  async function refresh() {
    if(disposed||busy||batchEditor||draggedId)return;
    const request=++generation;loading=true;showError();render();
    try {
      const [nextTasks,nextEvents]=await Promise.all([options.listTasks(),options.listEvents()]);
      if(disposed||request!==generation)return;
      if(!Array.isArray(nextTasks)||!Array.isArray(nextEvents))throw new Error('任务或日程列表响应无效');
      tasks=nextTasks;events=nextEvents;loaded=true;if(needsReconcile)deletion.innerHTML='';needsReconcile=false;
      editor.querySelectorAll('[type="submit"]').forEach(button=>{button.disabled=false;});updateChoices();
    }catch(failure){if(!disposed&&request===generation)showError(`读取失败：${failure?.message||'请刷新重试'}`);}
    finally{if(!disposed&&request===generation){loading=false;render();}}
  }
  async function mutate(id,patch,{expectedUpdatedAt,keepCards=false}={}) {
    if(disposed||busy||needsReconcile)return false;
    busy=true;++generation;loading=false;
    if(keepCards)root.setAttribute('aria-busy','true');
    else render();
    try {
      const saved=await options.patchTask(id,patch,expectedUpdatedAt?{expectedUpdatedAt}:undefined);
      if(disposed)return false;
      if(!saved||saved.id!==id)throw new Error('没有确认任务已保存，请刷新核查');
      tasks=tasks.map(task=>task.id===id?{...task,...saved}:task);updateChoices();showError();return true;
    }catch(failure){if(!disposed){const commit=failure?.commitState??failure?.data?.commitState;
      if(commit==='committed'||commit==='unknown'){needsReconcile=true;showError(`${commit==='committed'?'任务记录已保存，后续同步尚未完成':'保存结果未确认'}：${failure.message||'请核查'}。写操作已暂停，请刷新核查后再操作。`);}
      else showError(`保存失败：${failure?.message||'请重试'}`);
    }return false;}
    finally{busy=false;if(!disposed)render();}
  }
  function edit(task) {
    if(busy||needsReconcile)return;
    if(deletion.firstChild){showError('请先完成或取消删除确认。');return;}
    editor.innerHTML=`<form class="swp__form" aria-label="调整任务" data-edit-id="${escape(task.id)}"><h3>${escape(task.title)}</h3><div class="swp__fields"><label>优先级<select name="priority"><option value="">不设置</option>${Object.entries(priorities).map(([key,label])=>`<option value="${key}" ${task.priority===key?'selected':''}>${label}</option>`).join('')}</select></label><label>开始时间<input name="startAt" type="datetime-local" value="${escape(dateInput(task.startAt))}"></label><label>结束时间<input name="endAt" type="datetime-local" value="${escape(dateInput(task.endAt))}"></label></div><p class="swp__hint">提醒：${escape(displayDate(task.reminderAt))}。调整排期不会自动修改提醒，请检查提醒时间是否仍合适。</p><p class="swp__form-error" role="alert" hidden></p><footer><button type="button" data-planner-action="cancel">取消</button><button type="submit" class="swp__primary">保存安排</button></footer></form>`;
    originalTimes.set(editor.querySelector('form'),{startAt:task.startAt||null,endAt:task.endAt||null});
    editor.querySelector('[name="priority"]').focus();
  }
  function confirmDelete(task) {
    if(!task||busy||needsReconcile||!options.deleteTask)return;
    if(editor.querySelector('form')){showError('请先保存或取消正在调整的任务，再删除。');return;}
    deletion.innerHTML=`<form class="swp__delete-form" role="dialog" aria-modal="false" aria-label="删除任务确认"><h3>删除任务</h3><strong>${escape(task.title)}</strong><p>将删除这条任务及其文档正文，附件文件和已有 Agent 成果保留。请确认无需保留。</p><p role="alert" hidden></p><footer><button type="button" data-planner-action="cancel-delete">取消</button><button type="submit" class="swp__danger">确认删除</button></footer></form>`;
    deletion.querySelector('[data-planner-action="cancel-delete"]').focus();
    deletion.querySelector('form').addEventListener('submit',async event=>{
      event.preventDefault();if(disposed||busy||needsReconcile)return;
      const form=event.target;busy=true;++generation;loading=false;form.setAttribute('aria-busy','true');form.querySelector('[type="submit"]').textContent='正在删除…';
      form.querySelectorAll('button').forEach(button=>{button.disabled=true;});render();
      try{
        const result=await options.deleteTask(task.id,{expectedUpdatedAt:task.updatedAt});
        if(disposed)return;
        if(result?.id!==task.id||result.deleted!==true)throw new Error('未确认任务已删除');
        tasks=tasks.filter(item=>item.id!==task.id);updateChoices();showError();deletion.innerHTML='';
      }catch(failure){if(!disposed){
        const commit=failure?.commitState??failure?.data?.commitState;needsReconcile=commit!=='none';
        const message=form.querySelector('[role="alert"]');message.hidden=false;
        message.textContent=needsReconcile?`删除结果需核查：${failure?.message||'结果未知'}。请刷新核查后再操作。`:`删除失败：${failure?.message||'请重试'}`;
      }}finally{busy=false;if(!disposed){form.setAttribute('aria-busy','false');form.querySelector('[type="submit"]').textContent='确认删除';form.querySelectorAll('button').forEach(button=>{button.disabled=button.type==='submit'&&needsReconcile;});render();}}
    });
  }
  async function submit(event) {
    if(!event.target.matches('.swp__form'))return;event.preventDefault();if(busy||disposed||needsReconcile)return;
    const form=event.target,formError=form.querySelector('[role="alert"]');
    try {
      const value=name=>form.querySelector(`[name="${name}"]`).value;
      const original=originalTimes.get(form)||{};
      const timestamp=name=>value(name)===dateInput(original[name])?original[name]||null:value(name)?new Date(value(name)).toISOString():null;
      const startAt=timestamp('startAt'),endAt=timestamp('endAt');
      if(startAt&&endAt&&Date.parse(endAt)<Date.parse(startAt))throw new Error('结束时间不能早于开始时间');
      const patch={priority:value('priority')||null,startAt,endAt};
      formError.hidden=true;form.querySelectorAll('input,select,button').forEach(node=>{node.disabled=true;});
      const success=await mutate(form.dataset.editId,patch);
      if(!disposed&&success&&editor.contains(form))editor.innerHTML='';
    }catch(failure){if(!disposed){formError.textContent=failure.message;formError.hidden=false;}}
    finally{if(!disposed)form.querySelectorAll('input,select,button').forEach(node=>{node.disabled=node.matches('[type="submit"]')&&needsReconcile;});}
  }
  async function click(event) {
    const button=event.target.closest('button');if(!button||!root.contains(button)||button.disabled||disposed)return;
    if(button.dataset.plannerView){view=button.dataset.plannerView;render();return;}
    if(button.dataset.plannerMode){mode=button.dataset.plannerMode;render();return;}
    const action=button.dataset.plannerAction,id=button.dataset.recordId;
    if(action==='refresh')return refresh();
    if(action==='select-visible'){if(!busy&&!batchEditor){selected.clear();filtered().slice(0,20).forEach(task=>selected.add(task.id));render();}return;}
    if(action==='clear-selection'){if(!busy&&!batchEditor){selected.clear();render();}return;}
    if(action==='batch'){if(busy||needsReconcile||batchEditor||editor.firstChild||deletion.firstChild){showError('请先完成或取消当前编辑。');return;}if(!selected.size)return;const host=root.querySelector('.swp__batch-host');batchEditor=mountTaskBatchEditor(host,{ids:[...selected],previewTaskBatch:options.previewTaskBatch,executeTaskBatch:options.executeTaskBatch,listCategories:options.listCategories,onClose:()=>{batchEditor?.dispose();batchEditor=null;render();},onResults:result=>{if(disposed)return;++generation;for(const row of result.results){if(row.state==='saved'&&row.record){tasks=tasks.map(task=>task.id===row.id?row.record:task);selected.delete(row.id);}}needsReconcile=Boolean(result.uncertain||result.results.some(row=>row.state==='unknown'));if(needsReconcile)showError('部分保存结果需核查，请关闭结果后刷新；未自动重试。');updateChoices();render();}});render();return;}
    if(batchEditor&&['edit','delete','status'].includes(action)){showError('请先关闭批量操作面板。');return;}
    if(action==='cancel-delete'&&!busy){deletion.innerHTML='';return;}
    if(action==='delete'){confirmDelete(tasks.find(task=>task.id===id));return;}
    if(action==='clear'){view='all';search.value='';root.querySelector('.swp__unfinished').checked=false;Object.values(filters).forEach(node=>{node.value='';});render();return;}
    if(action==='cancel'&&!busy){editor.innerHTML='';return;}
    if(action==='edit'){const task=tasks.find(t=>t.id===id);if(task)edit(task);return;}
    if(action==='status')return mutate(id,{status:button.dataset.status});
    if(action==='automatic-quadrant'&&canMove()){const task=tasks.find(task=>task.id===id);if(task)return mutate(id,{quadrantOverride:null},{expectedUpdatedAt:task.updatedAt,keepCards:true});}
    if((action==='move-up'||action==='move-down')&&canMove()&&['board','quadrant'].includes(mode)){
      const task=tasks.find(task=>task.id===id);
      const group=sorted(filtered()).filter(item=>lane(item)===lane(task));
      const index=group.findIndex(item=>item.id===id);
      const neighbor=group[index+(action==='move-up'?-1:1)];
      if(neighbor)reorder(id,neighbor.id,action==='move-down');
      root.querySelector(`[data-planner-id="${id}"] [data-planner-action="${action}"]`)?.focus();
      return;
    }
    if(action==='this-week'||action==='prev-week'||action==='next-week'){
      if(action==='this-week')anchor=localDate(now());else{const date=new Date(`${weekStart(anchor)}T12:00:00`);date.setDate(date.getDate()+(action==='next-week'?7:-7));anchor=localDate(date);}render();return;
    }
    if(action==='open'||action==='focus'||action==='delegate'){
      try {if(action==='open'){if(!options.onOpenRecord)throw new Error('原生文档打开尚未配置');await options.onOpenRecord(id);}else if(action==='delegate')await options.onDelegateTask?.(tasks.find(t=>t.id===id));else await options.onFocusTask?.(tasks.find(t=>t.id===id));}
      catch(failure){if(!disposed)showError(`操作失败：${failure?.message||'请重试'}`);}
    }
  }
  const input=event=>{if(event.target===search)render();};
  async function moveTo(id,target) {
    if(!canMove()||!['board','quadrant'].includes(mode))return false;
    const task=tasks.find(task=>task.id===id);
    const valid=mode==='board'?labels:quadrants;
    if(!task||!Object.hasOwn(valid,target)||target===lane(task))return false;
    const patch=mode==='board'?{status:target}:{quadrantOverride:target};
    return mutate(id,patch,{expectedUpdatedAt:task.updatedAt,keepCards:true});
  }
  function clearDrag() {
    draggedId=null;
    for(const node of content.querySelectorAll('.swp__drop-target,.swp__drop-before,.swp__drop-after')){
      node.classList.remove('swp__drop-target','swp__drop-before','swp__drop-after');
    }
  }
  function onDragStart(event) {
    const card=event.target.closest('[data-planner-id]');
    if(!card)return;
    if(!canMove()||!['board','quadrant'].includes(mode)||!event.dataTransfer||event.target.closest('input,select,button,a,summary')){
      event.preventDefault();return;
    }
    draggedId=card.dataset.plannerId;
    event.dataTransfer.effectAllowed='move';
    event.dataTransfer.setData('text/plain',draggedId);
  }
  function dropTarget(event) {
    if(!draggedId||!canMove())return null;
    return event.target.closest('[data-task-drop]');
  }
  function onDragOver(event) {
    const target=dropTarget(event);
    for(const node of content.querySelectorAll('.swp__drop-target,.swp__drop-before,.swp__drop-after'))node.classList.remove('swp__drop-target','swp__drop-before','swp__drop-after');
    if(!target)return;
    event.preventDefault();
    event.dataTransfer.dropEffect='move';
    target.classList.add('swp__drop-target');
    const card=event.target.closest('[data-planner-id]');
    if(card&&card.dataset.plannerId!==draggedId){
      const after=event.clientY>card.getBoundingClientRect().top+card.getBoundingClientRect().height/2;
      card.classList.add(after?'swp__drop-after':'swp__drop-before');
    }
  }
  function onDrop(event) {
    const target=dropTarget(event),id=draggedId;
    const card=event.target.closest('[data-planner-id]');
    const after=card&&event.clientY>card.getBoundingClientRect().top+card.getBoundingClientRect().height/2;
    clearDrag();
    if(!target||!id)return;
    event.preventDefault();
    const task=tasks.find(task=>task.id===id);
    if(target.dataset.taskDrop===lane(task)){
      if(card&&card.dataset.plannerId!==id)reorder(id,card.dataset.plannerId,after);
      else if(!card){
        const group=sorted(filtered()).filter(item=>lane(item)===lane(task)&&item.id!==id);
        if(group.length)reorder(id,group.at(-1).id,true);
      }
    }else void moveTo(id,target.dataset.taskDrop);
  }
  const change=event=>{
    if(event.target.matches('[data-task-move]')){
      const id=event.target.dataset.taskMove,target=event.target.value;
      const task=tasks.find(task=>task.id===id);
      if(task)event.target.value=lane(task);
      void moveTo(id,target);
      return;
    }
    if(event.target.matches('[data-planner-select]')){if(busy||batchEditor||needsReconcile)return;const id=event.target.dataset.plannerSelect;if(event.target.checked){if(selected.size>=20){event.target.checked=false;showError('每次最多选择20项任务。');return;}selected.add(id);}else selected.delete(id);render();return;}if(Object.values(filters).includes(event.target)||event.target.matches('.swp__unfinished'))render();
  };
  root.addEventListener('dragstart',onDragStart);root.addEventListener('dragover',onDragOver);root.addEventListener('drop',onDrop);root.addEventListener('dragend',clearDrag);
  root.addEventListener('click',click);root.addEventListener('input',input);root.addEventListener('change',change);root.addEventListener('submit',submit);
  void refresh();
  return {refresh,refreshClock(){if(disposed||busy||loading||draggedId||editor.querySelector('form'))return;const focused=container.ownerDocument.activeElement;if(root.contains(focused)&&focused?.matches?.('input,textarea,select,[contenteditable=true],.swp__content button'))return;render();},setView(value,{unfinishedOnly=false}={}){if(disposed||!Object.hasOwn(views,value))return false;view=value;mode='list';search.value='';root.querySelector('.swp__unfinished').checked=unfinishedOnly;Object.values(filters).forEach(node=>{node.value='';});render();return true;},dispose(){disposed=true;clearDrag();root.removeEventListener('dragstart',onDragStart);root.removeEventListener('dragover',onDragOver);root.removeEventListener('drop',onDrop);root.removeEventListener('dragend',clearDrag);batchEditor?.dispose();++generation;root.removeEventListener('click',click);root.removeEventListener('input',input);root.removeEventListener('change',change);root.removeEventListener('submit',submit);}};
}
