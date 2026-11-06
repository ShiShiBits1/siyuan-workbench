import {WORK_TEMPLATES} from '../src/domain/work-templates.js';
import {mountJobBatchPanel} from './job-batch-panel.js';
import {createAgentMarkdownRenderer} from './agent-markdown.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const states={draft:'草稿',queued:'已接单',validating:'校验中',running:'执行中',needs_input:'待补充',awaiting_review:'待验收',changes_requested:'已退回',accepted:'已采纳',failed:'失败',canceled:'已取消'};
const types={material:'资料整理',meeting:'会议待办草稿',weekly:'周报草稿'};
const resumable=new Set(['draft','needs_input','changes_requested','failed']);
const interrupted=new Set(['queued','validating','running']);

/** Explicit material selection, bounded generation and a separate human acceptance step. */
export function mountAgentJobs(container,options={}){
  let disposed=false,jobs=[],tasks=[],materials=[],selected=null,editor=false,busy=false,uncertain=false,generation=0,active=null,previewGeneration=0,uncertainDocumentID=null,uncertainRunId=null,weeklyReferenceIds=[],batchPanel=null,refreshing=false;
  const doc=container.ownerDocument,markdown=createAgentMarkdownRenderer(doc);
  container.innerHTML=`<section class="swj" aria-label="Agent 委托"><header class="swj__head"><div data-workbench-page-intro><h2>Agent 委托</h2><p>交给助手整理，成果由你拍板。</p></div><div><button type="button" data-job-action="refresh">刷新</button><button type="button" data-job-action="new">新建委托</button>${options.batchRunner?'<button type="button" data-job-action="batch">受控批处理</button>':''}</div></header><p class="swj__notice">使用思源设置中的编辑器 AI 模型。只发送明确选择的材料、目标和补充答复；不读取附件内容、不运行工具。成果保存为普通思源文档，交稿后仍需你验收。</p><p class="swj__error" role="alert" hidden></p><div class="swj__reconcile" role="status"></div><div class="swj__batch" hidden></div><div class="swj__layout"><aside class="swj__sidebar"><label>委托状态<select aria-label="筛选委托状态"><option value="">全部状态</option><option value="active">执行中与待核查</option>${Object.entries(states).map(([key,title])=>`<option value="${key}">${title}</option>`).join('')}</select></label><div class="swj__list" role="list" aria-label="委托列表"></div></aside><div class="swj__detail"><p>选择一项委托，或新建一项范围明确的工作。</p></div></div><p class="swj__status" role="status" aria-live="polite"></p></section>`;
  const root=container.firstElementChild,list=root.querySelector('.swj__list'),detail=root.querySelector('.swj__detail'),filter=root.querySelector('select'),error=root.querySelector('[role="alert"]'),status=root.querySelector('.swj__status');
  const fail=message=>{if(disposed)return;error.hidden=!message;error.textContent=message||'';};
  const reconcile=root.querySelector('.swj__reconcile');
  const notifyRecordChange=()=>{try{void Promise.resolve(options.onRecordChange?.()).catch(()=>{});}catch{}};
  function reconcileUI() {
    const id=uncertainRunId||uncertainDocumentID;
    reconcile.innerHTML=uncertain?`<p>保存结果待核查${id?' · 文档 ID：'+escape(id):''}</p>${id?`<button type="button" data-job-open="${escape(id)}">打开待核查原生记录</button>`:''}<button type="button" data-job-action="recover">核查保存结果</button>`:'';
    reconcile.querySelector('button[data-job-action]')?.toggleAttribute('disabled',busy);
  }
  const dirty=()=>Boolean(detail.querySelector('[data-job-draft="true"]'));
  function canCancelRun() {
    return active?.action === 'run' && active.id === selected;
  }
  function setBusy(value) {
    busy=value;
    root.dataset.jobBusy=String(value);
    root.querySelector('[data-job-action="new"]').disabled=value||uncertain;
    reconcileUI();
    try{options.onBusyChange?.(value);}catch{}
    for(const node of root.querySelectorAll('[data-job-write]')) {
      const cancel=node.dataset.jobAction==='cancel';
      node.disabled=refreshing || (busy && !(cancel && canCancelRun())) ||
        (uncertain && node.dataset.jobAction!=='recover' && !(cancel && uncertainRunId===selected && selected));
    }
  }
  function showList(){
    const focusedJob=doc.activeElement?.dataset.jobSelect;
    list.innerHTML=jobs.filter(job=>!filter.value||(filter.value==='active'?interrupted.has(job.state):job.state===filter.value)).map(job=>`<article role="listitem"><button type="button" class="swj__job-card" data-job-select="${escape(job.id)}" aria-pressed="${selected===job.id}"><strong>${escape(job.title)}</strong><span>${escape(states[job.state]||job.state)} · ${escape(types[job.type]||job.type)}</span></button></article>`).join('')||'<p>暂无此类委托</p>';
    if (focusedJob) {
      const current=[...list.querySelectorAll('[data-job-select]')].find(button=>button.dataset.jobSelect===focusedJob);
      (current||filter).focus();
    }
  }
  function actionItemsHTML(job){return (job.actionItems||[]).length?`<section class="swj__items"><h4>会议行动项草稿</h4><p>逐项检查后建立待办；不会自动采纳成果或完成关联任务。</p>${job.actionItems.map((item,index)=>`<article><h4>${escape(item.title)}</h4><p>${escape(item.detail)}</p><p>开始：${escape(item.startAt||'待确认')} · 结束：${escape(item.endAt||'待确认')}</p>${item.error?`<p class="swj__warning">${escape(item.error)}</p>`:''}${item.status==='adopted'?`<button type="button" data-job-open="${escape(item.plannedTaskId)}">已建立，打开待办</button>`:['unknown','planned'].includes(item.status)?'<p>任务保存结果待核查，请先核查保存结果。</p><button type="button" data-job-action="recover" data-job-write>核查保存结果</button>':['awaiting_review','accepted'].includes(job.state)?`<button type="button" data-job-action="adopt" data-job-index="${index}" data-job-write>建立待办</button>`:'<p>成果交付后可逐项建立待办。</p>'}</article>`).join('')}</section>`:'';}
  function sourceSummary(job){return `<details class="swj__scope"><summary>查看本次外发范围</summary><p>目标：${escape(job.goal)}</p><p>所选文档 ${job.sourceIds.length} 篇；执行时读取当前正文，不包含附件二进制内容。</p><ul>${job.sourceIds.map(id=>`<li>${escape(materials.find(item=>item.id===id)?.title||id)} <code>${escape(id)}</code></li>`).join('')}</ul><pre>${escape(job.material||'未粘贴材料')}</pre><p>事实底稿引用 ${(job.referenceIds||[]).length} 条（仅引用定位，不重新读取全文）。</p><p>补充 ${job.supplements.length} 次，退回反馈 ${job.feedback.length} 条也会随本次生成发送。</p><p>最多一轮模型生成；只写入委托记录与新的成果草稿。不会自动完成业务任务。</p></details>`;}
  function showDetail(job){
    if(disposed||editor)return;++previewGeneration;selected=job.id;
    detail.innerHTML=`<article class="swj__job"><header><h3>${escape(job.title)}</h3><span class="swj__state">${escape(states[job.state]||job.state)}</span></header><p>${escape(job.goal)}</p><p>关联任务：${escape(tasks.find(task=>task.id===job.taskId)?.title||job.taskId||'无')} · ${escape(types[job.type]||job.type)}</p>${job.error?`<p class="swj__warning">${escape(typeof job.error==='string'?job.error:JSON.stringify(job.error))}</p>`:''}${job.taskCompletionError?`<p role="alert" class="swj__warning">${escape(job.taskCompletionError)}</p>`:''}${sourceSummary(job)}${job.questions?.length?`<section class="swj__questions"><h4>请集中补充以下资料</h4><ol>${job.questions.map(question=>`<li>${escape(question)}</li>`).join('')}</ol></section>`:''}${job.state==='needs_input'?'<label>集中答复<textarea name="answers" rows="5" maxlength="20000" placeholder="按问题补充资料，暂不清楚的内容请说明。"></textarea></label>':''}${job.feedback?.length?`<details><summary>退回记录（${job.feedback.length}）</summary><ol>${job.feedback.map(item=>`<li>${escape(typeof item==='string'?item:JSON.stringify(item))}</li>`).join('')}</ol></details>`:''}<div class="swj__actions">${resumable.has(job.state)?`<button type="button" data-job-action="run" data-job-write class="swj__primary">${job.state==='needs_input'?'补充并执行':job.state==='draft'?'确认范围并执行':'按当前范围重新执行'}</button>`:''}${interrupted.has(job.state)?'<p>上次执行尚未结束或已中断。请先核查实际成果；不会自动重复生成。</p><button type="button" data-job-action="recover" data-job-write>核查中断状态</button>':''}${!['accepted','canceled'].includes(job.state)?'<button type="button" data-job-action="cancel" data-job-write>取消委托</button>':''}<button type="button" data-job-action="open-job">打开委托文档</button></div><section class="swj__deliverables"><h4>成果记录</h4>${job.deliverables?.length?job.deliverables.map((item,i)=>`<p><span>成果草稿 ${i+1}</span> <button type="button" data-job-open="${escape(item.id)}">打开原生文档</button> <button type="button" data-job-preview="${escape(item.id)}">预览</button></p>`).join(''):'<p>尚未交付成果。</p>'}${job.state==='canceled' && job.plannedDeliverableId && !job.deliverables?.some(item=>item.id===job.plannedDeliverableId)?'<p>这次执行有一份待核查的成果。</p><button type="button" data-job-action="recover" data-job-write>核查成果</button>':''}<div class="swj__preview" aria-label="成果预览"></div></section>${actionItemsHTML(job)}${job.state==='awaiting_review'?`<section class="swj__review"><h4>由你验收</h4><p>采纳仅确认本次成果。需要修改时填写反馈并退回，已交付的原稿保留。</p>${job.taskId?'<label class="swj__check"><input type="checkbox" name="completeTask">同时将关联任务标记为完成</label>':''}<button type="button" data-job-action="accept" data-job-write class="swj__primary">采纳成果</button><label>退回意见<textarea name="feedback" rows="3" maxlength="20000" placeholder="说明需要改进的内容或补充要求。"></textarea></label><button type="button" data-job-action="return" data-job-write>按意见退回</button></section>`:''}<p class="swj__stop-note">停止或取消仅终止后续工作；已保存的委托和成果会保留，不会回滚。</p></article>`;
    showList();setBusy(busy);
  }
  async function refresh(){
    if(disposed||busy)return;const request=++generation;refreshing=true;setBusy(busy);
    try{const result=await Promise.all([options.repository.list(),options.listTasks?.()||[],options.listMaterials?.()||[]]);if(disposed||request!==generation)return;if(!result.every(Array.isArray))throw new Error('委托或资料列表响应无效');[jobs,tasks,materials]=result;showList();if(selected&&!editor&&!dirty()){const job=jobs.find(item=>item.id===selected);if(job)showDetail(job);else{selected=null;detail.textContent='此委托已不在当前列表，请核查原生文档。';}}fail('');status.textContent=`${jobs.length} 项委托 · 采纳不会自动完成任务`;}catch(failure){if(!disposed&&request===generation)fail(`读取失败：${failure.message||'请重试'}。保留已有列表。`);}finally{if(!disposed&&request===generation){refreshing=false;setBusy(busy);}}
  }
  function showEditor(task){
    if(disposed||busy)return false;if(uncertain){fail('请先核查上次保存结果，输入继续保留。');return false;}++previewGeneration;if(dirty()){fail('请先保存或取消当前草稿。');return false;}if(task&&!tasks.some(item=>item.id===task.id))tasks=[...tasks,task];editor=true;selected=null;weeklyReferenceIds=[];showList();
    detail.innerHTML=`<form class="swj__draft" aria-label="新建 Agent 委托" ${task?'data-job-draft="true"':''}><h3>新建委托</h3><label>关联任务<select name="taskId"><option value="">独立委托</option>${tasks.map(item=>`<option value="${escape(item.id)}" ${task?.id===item.id?'selected':''}>${escape(item.title)}</option>`).join('')}</select></label><label>工作类型<select name="template">${Object.entries(types).map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select></label><button type="button" data-job-action="template">追加模板要求</button><section class="swj__weekly" hidden><label>起始日期<input name="weeklyFrom" type="date"></label><label>结束日期<input name="weeklyTo" type="date"></label><button type="button" data-job-action="weekly" data-job-write>准备事实底稿</button><p>仅在点击时读取当前笔记本任务与日程的事实元数据，不调用模型；底稿将追加到粘贴材料，供你预览后决定是否外发。</p></section><label>标题<input name="title" maxlength="200" required value="${escape(task?task.title+' · 委托':'')}"></label><label>目标与验收要求<textarea name="objective" rows="4" maxlength="20000" required placeholder="说明要交付什么、依据什么判断完成。">${escape(task?.detail||'')}</textarea></label><fieldset><legend>明确选择材料（最多20篇）</legend><label>搜索材料<input type="search" name="materialSearch" placeholder="按标题筛选"></label><div class="swj__materials">${materials.map(item=>`<label class="swj__check" data-material-title="${escape(String(item.title||'').toLowerCase())}"><input type="checkbox" name="materialIds" value="${escape(item.id)}">${escape(item.title||item.id)}</label>`).join('')||'<p>当前没有可选笔记，可直接粘贴材料。</p>'}</div></fieldset><label>粘贴材料<textarea name="pastedMaterial" rows="6" maxlength="100000" placeholder="只粘贴本次处理所需的会议记录或资料。"></textarea></label><p class="swj__scope-live" role="status">尚未选择文档；保存草稿不会调用模型。</p><p>执行时将目标、所选文档正文、粘贴材料及后续补充答复发送给思源配置的编辑器 AI 模型。先保存草稿，核对范围后再执行。</p><footer><button type="button" data-job-action="discard">取消草稿</button><button type="submit" data-job-write class="swj__primary">保存委托草稿</button></footer></form>`;return true;
  }
  async function operate(action,index) {
    const cancel=action==='cancel';
    if(disposed || refreshing || (busy && !(cancel && canCancelRun()))) return;
    if(uncertain && action!=='recover' && !(cancel && selected && selected===uncertainRunId)) return;
    let job=jobs.find(item=>item.id===selected);
    if(!job && action==='recover' && uncertainDocumentID) job={id:uncertainRunId||uncertainDocumentID};
    if(!job) throw new Error('请刷新并选择委托，或打开待核查原生记录手工核查');
    const answers=detail.querySelector('[name="answers"]')?.value.trim();
    const feedback=detail.querySelector('[name="feedback"]')?.value.trim();
    if(action==='run' && job.state==='needs_input' && !answers) throw new Error('请集中填写补充答复');
    if(action==='return' && !feedback) throw new Error('请填写退回意见');
    const completeTask=Boolean(detail.querySelector('[name="completeTask"]')?.checked);
    const operation={action,id:job.id,controller:new AbortController()};
    active=operation;
    const current=()=>!disposed && active===operation;
    function display(fresh) {
      jobs=jobs.some(item=>item.id===fresh.id)?jobs.map(item=>item.id===fresh.id?fresh:item):[fresh,...jobs];
      showDetail(fresh);
    }
    setBusy(true);
    fail('');
    status.textContent=cancel?'正在取消委托并核对已保存的成果…':action==='run'?'正在核查材料并生成，请等待…':'正在保存你的决定…';
    try {
      let result;
      if(action==='run') result=await options.runner.run(job.id,answers,{signal:operation.controller.signal,onToken:()=>{if(current())status.textContent='正在生成成果草稿…';}});
      else if(action==='accept') result=await options.runner.accept(job.id,{completeTask});
      else if(action==='return') result=await options.runner.return(job.id,feedback);
      else if(cancel) result=await options.runner.cancel(job.id);
      else if(action==='recover') result=await options.runner.recover(job.id);
      else if(action==='adopt') result=await options.runner.adoptActionItem(job.id,index);
      if(!current()) return;
      const fresh=result?.id?result:await options.repository.get(job.id);
      if(!current()) return;
      if(cancel && (fresh?.id!==job.id || fresh.state!=='canceled')) throw new Error('取消结果尚未确认，请核查委托状态');
      if(action==='recover'||cancel) {
        uncertain=false;uncertainDocumentID=null;uncertainRunId=null;
        editor=false;reconcileUI();
      }
      display(fresh);notifyRecordChange();
      status.textContent=cancel?'委托已取消。':'已保存。成果仍以委托记录中的状态为准。';
    }catch(failure){
      if(!current())return;
      const commit=failure.commitState??failure.data?.commitState;
      if(commit==='unknown'||commit==='committed'){
        uncertain=true;uncertainDocumentID=failure.documentID||job.id;
        if(action==='run'||cancel) uncertainRunId=job.id;
      }
      if(action==='run'||cancel) {
        try {
          const fresh=await options.repository.get(job.id);
          if(!current()) return;
          display(fresh);
        }catch{ /* Keep the operation error visible when rereading also fails. */ }
      }
      if(!current())return;
      status.textContent=uncertain?'保存结果待核查，执行已暂停。':'本次操作已停止或失败，请检查委托状态。';
      fail(`${failure.message||'操作失败'}${uncertain?'。写入结果需要核查，请检查委托与成果。':''}`);
    }finally{
      if(current()){active=null;setBusy(false);}
    }
  }
  async function click(event){const button=event.target.closest('button');if(!button||!root.contains(button)||button.disabled||disposed)return;try{
    if(button.dataset.jobOpen){await options.onOpenRecord?.(button.dataset.jobOpen);return;}
    if(button.dataset.jobPreview){const id=button.dataset.jobPreview,request=++previewGeneration,target=detail.querySelector('.swj__preview'),material=await options.repository.readMaterial(id);if(!disposed&&request===previewGeneration&&detail.contains(target))markdown(target,material.content);return;}
    if(button.dataset.jobSelect){if(uncertain){fail('请先核查上次保存结果，再切换委托。');return;}if(busy||dirty()){fail('请先保存或取消当前草稿，再切换委托。');return;}editor=false;const job=jobs.find(item=>item.id===button.dataset.jobSelect);if(job)showDetail(job);return;}
    const action=button.dataset.jobAction;
    if(action==='batch'){if(busy||uncertain||dirty()){fail('请先完成当前编辑或核查，再打开批处理。');return;}const host=root.querySelector('.swj__batch');host.hidden=!host.hidden;if(!host.hidden&&!batchPanel)batchPanel=mountJobBatchPanel(host,{repository:options.repository,batchRunner:options.batchRunner,canStart:()=>!busy&&!uncertain&&!dirty(),onOpenRecord:options.onOpenRecord,onBusyChange:value=>setBusy(value),onRecordChange:async()=>{await refresh();notifyRecordChange();}});return;}
    if(action==='template'){if(busy||uncertain)return;const form=detail.querySelector('form'),goal=form.querySelector('[name="objective"]'),template=WORK_TEMPLATES[form.querySelector('[name="template"]').value];goal.value=[goal.value,template.goal].filter(Boolean).join('\n\n');form.dataset.jobDraft='true';return;}
    if(action==='weekly'){if(busy||uncertain)return;if(!options.prepareWeekly)throw new Error('事实底稿暂未配置');const form=detail.querySelector('form'),from=form.querySelector('[name="weeklyFrom"]').value,to=form.querySelector('[name="weeklyTo"]').value;if(!from||!to||from>to)throw new Error('请选择有效的起始和结束日期');setBusy(true);try{const prepared=await options.prepareWeekly({from,to});if(disposed||!detail.contains(form))return;if(typeof prepared?.pastedMaterial!=='string'||!Array.isArray(prepared.referenceIds))throw new Error('事实底稿响应无效');const field=form.querySelector('[name="pastedMaterial"]');field.value=[field.value,prepared.pastedMaterial].filter(Boolean).join('\n\n');weeklyReferenceIds=[...new Set([...weeklyReferenceIds,...prepared.referenceIds])];if(!form.querySelector('[name="title"]').value&&prepared.title)form.querySelector('[name="title"]').value=prepared.title;form.dataset.jobDraft='true';form.querySelector('.swj__scope-live').textContent=`已追加事实底稿，引用 ${weeklyReferenceIds.length} 项；请在粘贴材料中预览，不会自动调用模型。`;}finally{if(!disposed)setBusy(false);}return;}
    if(action==='new'){await initialReady;if(!disposed)showEditor();return;}if(action==='refresh'){await refresh();return;}if(action==='discard'&&!busy){if(uncertain){fail('保存结果待核查，输入继续保留；请先核查原生记录。');return;}++previewGeneration;editor=false;detail.innerHTML='<p>草稿已取消，尚未保存的输入已清除。</p>';return;}if(action==='open-job'){await options.onOpenRecord?.(selected);return;}if(['run','accept','return','cancel','recover','adopt'].includes(action))await operate(action,Number(button.dataset.jobIndex));
  }catch(failure){fail(failure.message||'操作失败');}}
  async function submit(event){if(!event.target.matches('.swj__draft'))return;event.preventDefault();if(disposed||busy||refreshing||uncertain)return;const form=event.target,value=name=>form.querySelector(`[name="${name}"]`).value;
    setBusy(true);fail('');try{const job=await options.runner.create({title:value('title'),objective:value('objective'),taskId:value('taskId')||null,template:value('template'),materialIds:[...form.querySelectorAll('[name="materialIds"]')].filter(node=>node.checked).map(node=>node.value),pastedMaterial:value('pastedMaterial'),referenceIds:weeklyReferenceIds});if(disposed)return;editor=false;jobs.unshift(job);showDetail(job);status.textContent='草稿已保存。请核对外发范围，然后点击“确认范围并执行”。';notifyRecordChange();}
    catch(failure){if(disposed)return;const commit=failure.commitState??failure.data?.commitState;uncertain=commit==='unknown'||commit==='committed';if(uncertain){uncertainDocumentID=failure.documentID||null;form.dataset.jobDraft='true';}fail(`${failure.message||'保存失败'}${uncertain?'。草稿写入结果未确认，请保留输入并核查原生记录；不要重复创建。':''}`);}
    finally{if(!disposed)setBusy(false);}
  }
  function input(event){if(!detail.contains(event.target))return;const form=detail.querySelector('form');if(event.target.name==='materialSearch'){const query=event.target.value.trim().toLowerCase();detail.querySelectorAll('[data-material-title]').forEach(node=>node.hidden=!node.dataset.materialTitle.includes(query));return;}if(form){form.dataset.jobDraft='true';const chosen=[...form.querySelectorAll('[name="materialIds"]')].filter(node=>node.checked);form.querySelector('.swj__scope-live').textContent=`已选择 ${chosen.length} 篇文档 · 粘贴材料 ${form.querySelector('[name="pastedMaterial"]').value.length} 字；保存草稿不会调用模型。`;}else if(event.target.matches('textarea'))event.target.dataset.jobDraft=String(Boolean(event.target.value));}
  const change=event=>{if(event.target===filter)showList();else{if(event.target.name==='template')detail.querySelector('.swj__weekly').hidden=event.target.value!=='weekly';input(event);}};
  root.addEventListener('click',click);root.addEventListener('submit',submit);root.addEventListener('input',input);root.addEventListener('change',change);const initialReady=refresh();
  return {refresh,async createFromTask(task){await initialReady;return showEditor(task);},selectState(value){if(disposed)return;filter.value=value;showList();},dispose(){if(disposed)return;disposed=true;++generation;++previewGeneration;active?.controller.abort();batchPanel?.dispose();try{options.onBusyChange?.(false);}catch{}root.removeEventListener('click',click);root.removeEventListener('submit',submit);root.removeEventListener('input',input);root.removeEventListener('change',change);}};
}
