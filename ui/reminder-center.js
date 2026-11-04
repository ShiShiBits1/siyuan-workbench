const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const views={all:'全部提醒',upcoming:'待到期',due:'已到期','completed-task':'已完成任务'};
const inputTime=value=>{const d=new Date(value);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;};

/** Reminder scheduling view. It never claims to represent toast delivery or acknowledgements. */
export function mountReminderCenter(container,options={}) {
  let records=[],view='all',disposed=false,generation=0,busy=false,loading=false,loaded=false,verifyRequired=false;
  const now=()=>new Date(typeof options.now==='function'?options.now():options.now??Date.now());
  container.innerHTML=`<section class="swrc" aria-label="提醒中心"><header class="swrc__head"><div data-workbench-page-intro><h2>提醒中心</h2><p>统一安排任务和日程的提醒时间。</p></div><button type="button" data-reminder-action="refresh">刷新</button></header><p class="swrc__notice">这里显示提醒安排，不代表提示已送达。已完成任务不触发提醒；退出思源或设备休眠期间不保证准时。</p><nav class="swrc__views" aria-label="提醒范围">${Object.entries(views).map(([key,label])=>`<button type="button" data-reminder-view="${key}" aria-pressed="${key==='all'}">${label}</button>`).join('')}</nav><div class="swrc__tools"><label>搜索提醒<input type="search" aria-label="搜索提醒标题" placeholder="输入任务或日程标题"></label><label>类型<select aria-label="筛选提醒类型"><option value="">任务和日程</option><option value="task">仅任务</option><option value="event">仅日程</option></select></label></div><p class="swrc__summary" role="status" aria-live="polite"></p><p class="swrc__error" role="alert" hidden></p><div class="swrc__editor"></div><div class="swrc__list"></div></section>`;
  const root=container.querySelector('.swrc'),search=root.querySelector('[type="search"]'),type=root.querySelector('select');
  const summary=root.querySelector('.swrc__summary'),error=root.querySelector('.swrc__error'),editor=root.querySelector('.swrc__editor'),list=root.querySelector('.swrc__list');
  const showError=message=>{error.textContent=message||'';error.hidden=!message;};
  const state=record=>record.kind==='task'&&record.status==='done'?'completed-task':Date.parse(record.reminderAt)<=now().getTime()?'due':'upcoming';
  function render() {
    if(disposed)return;
    const eligible=records.filter(record=>record.reminderAt);
    const shown=eligible.filter(record=>(view==='all'||state(record)===view)&&(!type.value||record.kind===type.value)&&(!search.value.trim()||record.title.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())))
      .sort((a,b)=>Date.parse(a.reminderAt)-Date.parse(b.reminderAt)||a.id.localeCompare(b.id));
    summary.textContent=loading?'正在读取提醒…':`显示 ${shown.length} / ${eligible.length} 条提醒安排`;
    root.setAttribute('aria-busy',String(loading));root.querySelectorAll('[data-reminder-view]').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.reminderView===view)));
    list.innerHTML=shown.length?shown.map(record=>`<article class="swrc__item" data-reminder-id="${escape(record.id)}"><div class="swrc__document"><div class="swrc__identity"><span class="swrc__kind">${record.kind==='task'?'任务':'日程'}</span><button type="button" class="swrc__title" data-reminder-action="open" data-record-id="${escape(record.id)}">${escape(record.title)}</button></div><p class="swrc__time"><time>${escape(inputTime(record.reminderAt).replace('T',' '))}</time><span class="swrc__state swrc__state--${state(record)}">${views[state(record)]}</span></p></div><div class="swrc__actions"><button type="button" data-reminder-action="snooze15" data-record-id="${escape(record.id)}" ${busy||verifyRequired?'disabled':''}>15 分钟后</button><button type="button" data-reminder-action="snooze60" data-record-id="${escape(record.id)}" ${busy||verifyRequired?'disabled':''}>1 小时后</button><button type="button" data-reminder-action="edit" data-record-id="${escape(record.id)}" ${busy||verifyRequired?'disabled':''}>调整时间</button><button type="button" data-reminder-action="clear" data-record-id="${escape(record.id)}" ${busy||verifyRequired?'disabled':''}>清除提醒</button></div></article>`).join(''):`<div class="swrc__empty"><strong>${loading?'正在读取提醒':!loaded?'提醒暂未加载':eligible.length?'没有符合条件的提醒':'还没有提醒安排'}</strong><p>在任务或日程中设置提醒时间后，可在这里统一调整。</p></div>`;
  }
  async function refresh() {
    if(disposed||busy)return;
    const request=++generation;loading=true;showError();render();
    try{
      const [tasks,events]=await Promise.all([options.listTasks(),options.listEvents()]);
      if(disposed||request!==generation)return;
      if(!Array.isArray(tasks)||!Array.isArray(events))throw new Error('提醒列表响应无效');
      const next=[...tasks,...events];if(next.some(record=>typeof record.title!=='string'||(record.reminderAt&&!Number.isFinite(Date.parse(record.reminderAt)))))throw new Error('提醒时间或标题无效，请检查源记录');
      records=next;loaded=true;verifyRequired=false;
      editor.querySelectorAll('button[type="submit"]').forEach(button=>{button.disabled=false;});
    }catch(failure){if(!disposed&&request===generation)showError(`读取失败：${failure?.message||'请刷新重试'}`);}
    finally{if(!disposed&&request===generation){loading=false;render();}}
  }
  async function mutate(id,reminderAt) {
    if(disposed||busy||verifyRequired)return false;
    busy=true;++generation;loading=false;render();
    try{
      const saved=await options.patchReminder(id,{reminderAt});
      if(disposed)return false;
      if(!saved||saved.id!==id||saved.reminderAt!==reminderAt)throw Object.assign(new Error('没有确认提醒已保存'),{commitState:'unknown'});
      records=records.map(record=>record.id===id?{...record,...saved}:record);showError();return true;
    }catch(failure){
      if(!disposed){const commit=failure?.commitState??failure?.data?.commitState;
        if(commit==='committed'||commit==='unknown'){verifyRequired=true;showError(`${commit==='committed'?'提醒记录已保存，但后续同步未完成':'提醒保存结果无法确认'}：${failure?.message||'请核查'}。请先刷新核查，写操作已暂停。`);}
        else showError(`保存失败：${failure?.message||'请重试'}。安排仍保留，可重试。`);
      }return false;
    }finally{busy=false;if(!disposed)render();}
  }
  function edit(record) {
    if(busy||verifyRequired)return;
    editor.innerHTML=`<form class="swrc__form" aria-label="调整提醒" data-edit-id="${escape(record.id)}"><div><h3>${escape(record.title)}</h3><p>${record.kind==='task'&&record.status==='done'?'已完成任务不会触发提醒；恢复待办后才可能提示。':'仅调整提醒时间，起止时间保持。'}</p></div><label>提醒时间<input type="datetime-local" name="reminderAt" value="${escape(inputTime(record.reminderAt))}" required></label><p class="swrc__form-error" role="alert" hidden></p><footer><button type="button" data-reminder-action="cancel">取消</button><button type="submit" class="swrc__primary">保存提醒</button></footer></form>`;
    editor.querySelector('input').focus();
  }
  async function submit(event) {
    if(!event.target.matches('.swrc__form'))return;event.preventDefault();if(disposed||busy||verifyRequired)return;
    const form=event.target,message=form.querySelector('[role="alert"]');message.hidden=true;
    try{
      const raw=form.querySelector('input').value;if(!raw)throw new Error('请选择提醒时间');const reminderAt=new Date(raw).toISOString();
      form.querySelectorAll('input,button').forEach(control=>{control.disabled=true;});
      if(await mutate(form.dataset.editId,reminderAt)&&!disposed&&editor.contains(form))editor.innerHTML='';
    }catch(failure){if(!disposed){message.textContent=failure.message;message.hidden=false;}}
    finally{if(!disposed)form.querySelectorAll('input,button').forEach(control=>{control.disabled=control.type==='submit'&&verifyRequired;});}
  }
  async function click(event) {
    const button=event.target.closest('button');if(disposed||!button||!root.contains(button)||button.disabled)return;
    if(button.dataset.reminderView){view=button.dataset.reminderView;render();return;}
    const action=button.dataset.reminderAction,id=button.dataset.recordId;
    if(action==='refresh')return refresh();
    if(action==='cancel'&&!busy){editor.innerHTML='';return;}
    if(action==='edit'){const record=records.find(item=>item.id===id);if(record)edit(record);return;}
    if(action==='clear')return mutate(id,null);
    if(action==='snooze15'||action==='snooze60')return mutate(id,new Date(now().getTime()+(action==='snooze15'?15:60)*60000).toISOString());
    if(action==='open')try{if(!options.onOpenRecord)throw new Error('原生文档打开尚未配置');await options.onOpenRecord(id);}catch(failure){if(!disposed)showError(`打开文档失败：${failure?.message||'请重试'}`);}
  }
  const input=event=>{if(event.target===search)render();};
  const change=event=>{if(event.target===type)render();};
  root.addEventListener('click',click);root.addEventListener('input',input);root.addEventListener('change',change);root.addEventListener('submit',submit);void refresh();
  return {refresh,dispose(){disposed=true;++generation;root.removeEventListener('click',click);root.removeEventListener('input',input);root.removeEventListener('change',change);root.removeEventListener('submit',submit);}};
}
