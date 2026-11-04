import {getPomodoroState,getPomodoroConfiguration,configurePomodoro,controlPomodoro,subscribePomodoro} from './workbench.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/** The view subscribes to the existing module clock; no second interval or task mutation. */
export function mountFocusControls(container,options={}) {
  let disposed=false,generation=0,tasks=[],busy=false,targetsLoaded=false;
  const configuration=getPomodoroConfiguration();
  let reflectedConfiguration=configuration;
  const targetKey=target=>target?JSON.stringify([target.notebookId,target.id,target.title]):'';
  container.innerHTML=`<section class="swfc" aria-label="专注设置"><header><div data-workbench-page-intro><h2>专注与休息</h2><p>选择一件事，为它留出专注时间。</p></div><button type="button" data-focus-action="refresh">刷新任务</button></header><div class="swfc__clock" role="status" aria-live="off"><strong data-focus-time></strong><span data-focus-status></span><p data-focus-target></p></div><div class="swfc__controls"><button type="button" data-focus-control="focus">专注</button><button type="button" data-focus-control="break">休息</button><button type="button" class="swfc__primary" data-focus-control="toggle">开始</button><button type="button" data-focus-control="reset">重置</button></div><form class="swfc__form" aria-label="配置专注"><div class="swfc__fields"><label>专注分钟<input name="focusMinutes" type="number" min="1" max="180" step="1" value="${configuration.focusMinutes}" required></label><label>休息分钟<input name="breakMinutes" type="number" min="1" max="60" step="1" value="${configuration.breakMinutes}" required></label><label class="swfc__target-field">专注目标<select name="target" aria-label="选择专注任务"><option value="">不关联任务</option></select></label></div><p>应用设置会重置本轮计时；计时运行中请先暂停。关联目标不会自动修改任务状态。</p><button type="submit" class="swfc__primary">应用设置并重置本轮</button></form><p class="swfc__notice">关闭工作台后计时继续；禁用插件后暂停，恢复时不会自动开始。退出思源或休眠期间不保证提示。</p><p class="swfc__error" role="alert" hidden></p><p class="swfc__saved" role="status" hidden></p></section>`;
  const root=container.querySelector('.swfc'),form=root.querySelector('form'),select=form.querySelector('select'),error=root.querySelector('[role="alert"]'),saved=root.querySelector('.swfc__saved');
  form.setAttribute('data-workbench-draft','false');
  const discard=container.ownerDocument.createElement('button');discard.type='button';discard.dataset.focusAction='discard';discard.textContent='撤销未应用设置';discard.hidden=true;form.append(discard);
  const showError=message=>{error.textContent=message||'';error.hidden=!message;};
  function updateDraft() {
    if(disposed)return;
    const config=getPomodoroConfiguration(),expectedTarget=config.target?.notebookId===options.notebookId?config.target.id:'';
    const dirty=form.querySelector('[name="focusMinutes"]').value!==String(config.focusMinutes)
      ||form.querySelector('[name="breakMinutes"]').value!==String(config.breakMinutes)
      ||(targetsLoaded&&select.value!==expectedTarget);
    form.dataset.workbenchDraft=String(dirty);discard.hidden=!dirty;discard.disabled=busy;
  }
  function discardDraft() {
    const config=getPomodoroConfiguration();
    for(const name of ['focusMinutes','breakMinutes'])form.querySelector(`[name="${name}"]`).value=String(config[name]);
    const expected=config.target?.notebookId===options.notebookId?config.target.id:'';
    if(expected&&![...select.querySelectorAll('option')].some(option=>option.value===expected)){
      const option=container.ownerDocument.createElement('option');option.value=expected;option.textContent='原目标已完成或不可用，请重新选择';select.append(option);
    }
    select.value=expected;reflectedConfiguration=config;updateDraft();
  }
  function renderClock() {
    if(disposed)return;
    const state=getPomodoroState(),config=getPomodoroConfiguration(),seconds=Math.ceil(state.remainingMs/1000);
    // The clock can be configured from the dock while this form stays mounted.
    // Only fields still reflecting the previous configuration are pristine.
    for(const name of ['focusMinutes','breakMinutes']){
      const input=form.querySelector(`[name="${name}"]`);
      if(config[name]!==reflectedConfiguration[name]&&input.value===String(reflectedConfiguration[name]))input.value=String(config[name]);
    }
    const previousTarget=reflectedConfiguration.target?.notebookId===options.notebookId?reflectedConfiguration.target.id:'';
    const nextTarget=config.target?.notebookId===options.notebookId?config.target.id:'';
    if(targetsLoaded&&targetKey(config.target)!==targetKey(reflectedConfiguration.target)&&select.value===previousTarget){
      if(nextTarget&&!Array.from(select.options||select.querySelectorAll('option')).some(option=>option.value===nextTarget)){
        const option=container.ownerDocument.createElement('option');option.value=nextTarget;option.textContent=config.target.title;select.append(option);
      }
      select.value=nextTarget;
    }
    if(nextTarget){const option=[...select.querySelectorAll('option')].find(node=>node.value===nextTarget);if(option)option.textContent=config.target.title;}
    reflectedConfiguration=config;
    root.querySelector('[data-focus-time]').textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
    root.querySelector('[data-focus-status]').textContent=state.status==='running'?(state.phase==='focus'?'正在专注':'正在休息'):state.status==='paused'?'已暂停':state.status==='finished'?'本轮完成':state.phase==='focus'?'准备专注':'准备休息';
    root.querySelector('[data-focus-target]').textContent=!config.target?'未关联任务':config.target.notebookId===options.notebookId?`专注目标：${config.target.title}`:'当前专注目标属于其他笔记本';
    const toggle=root.querySelector('[data-focus-control="toggle"]');toggle.textContent=state.status==='running'?'暂停':state.status==='paused'?'继续':'开始';
    root.querySelectorAll('[data-focus-control]').forEach(button=>{button.disabled=busy;const phase=button.dataset.focusControl;if(phase==='focus'||phase==='break'){button.textContent=`${phase==='focus'?'专注':'休息'} ${phase==='focus'?config.focusMinutes:config.breakMinutes} 分钟`;button.setAttribute('aria-pressed',String(state.phase===phase));}});
    form.querySelector('[type="submit"]').disabled=busy||state.status==='running';
    updateDraft();
  }
  async function persist() {
    try{
      if(!options.persistSnapshot)throw new Error('保存接口尚未配置');
      await options.persistSnapshot(getPomodoroState());if(!disposed){saved.textContent='计时状态已保存';saved.hidden=false;}
    }catch(failure){if(!disposed)showError(`当前已应用，但保存失败：${failure?.message||'请重试'}。重启可能丢失本次设置或进度。`);}
  }
  async function refresh() {
    if(disposed)return;const request=++generation;
    try{
      const result=await options.listTasks();if(disposed||request!==generation)return;
      if(!Array.isArray(result))throw new Error('任务列表响应无效');
      tasks=result.filter(task=>task.status!=='done');
      const config=getPomodoroConfiguration();
      const targetChanged=targetKey(config.target)!==targetKey(reflectedConfiguration.target);
      const preferred=targetsLoaded&&!targetChanged?select.value:(config.target?.notebookId===options.notebookId?config.target.id:'');targetsLoaded=true;
      // External task selection should be reflected without erasing unapplied duration drafts.
      for(const name of ['focusMinutes','breakMinutes']){
        const input=form.querySelector(`[name="${name}"]`);
        if(config[name]!==reflectedConfiguration[name]&&input.value===String(reflectedConfiguration[name]))input.value=String(config[name]);
      }
      reflectedConfiguration=config;
      select.innerHTML='<option value="">不关联任务</option>'+tasks.map(task=>`<option value="${escape(task.id)}">${escape(task.title)}</option>`).join('');
      if(preferred&&!tasks.some(task=>task.id===preferred))select.innerHTML+=`<option value="${escape(preferred)}">原目标已完成或不可用，请重新选择</option>`;
      select.value=preferred;renderClock();
    }catch(failure){if(!disposed&&request===generation)showError(`读取任务失败：${failure?.message||'请刷新重试'}`);}
  }
  async function apply(event) {
    event.preventDefault();if(disposed||busy)return;showError();saved.hidden=true;
    try{
      const targetID=select.value,task=tasks.find(task=>task.id===targetID);if(targetID&&!task)throw new Error('所选目标已不可用，请重新选择');
      configurePomodoro({focusMinutes:Number(form.querySelector('[name="focusMinutes"]').value),breakMinutes:Number(form.querySelector('[name="breakMinutes"]').value),target:task?{notebookId:options.notebookId,id:task.id,title:task.title}:null});
      reflectedConfiguration=getPomodoroConfiguration();
      updateDraft();
      busy=true;renderClock();await persist();
    }catch(failure){if(!disposed)showError(failure?.message||'应用设置失败');}
    finally{busy=false;renderClock();}
  }
  async function click(event) {
    const button=event.target.closest('button');if(disposed||busy||!button||!root.contains(button)||button.disabled)return;
    if(button.dataset.focusAction==='refresh')return refresh();
    if(button.dataset.focusAction==='discard'){discardDraft();return;}
    if(button.dataset.focusControl){showError();saved.hidden=true;busy=true;
      try{const action=button.dataset.focusControl;controlPomodoro(action==='toggle'?(getPomodoroState().status==='running'?'pause':'start'):action);renderClock();await persist();}
      catch(failure){if(!disposed)showError(failure.message||'计时操作失败');}
      finally{busy=false;renderClock();}
    }
  }
  const draftChange=event=>{if(form.contains(event.target))updateDraft();};
  root.addEventListener('click',click);form.addEventListener('submit',apply);form.addEventListener('input',draftChange);form.addEventListener('change',draftChange);
  const unsubscribe=subscribePomodoro(renderClock);void refresh();
  return {refresh,dispose(){disposed=true;++generation;unsubscribe();root.removeEventListener('click',click);form.removeEventListener('submit',apply);form.removeEventListener('input',draftChange);form.removeEventListener('change',draftChange);}};
}
