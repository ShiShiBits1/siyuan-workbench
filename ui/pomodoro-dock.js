import {getPomodoroState,getPomodoroConfiguration,configurePomodoro,controlPomodoro,subscribePomodoro} from './workbench.js';

/** A view of the shared clock. Hiding or closing the dock never pauses it. */
export function mountPomodoroDock(container,options={}) {
  let disposed=false,busy=false,context=null,contextValid=false,loading=false,generation=0,taskDirty=false;
  container.innerHTML='<section class="swpd" aria-label="侧栏番茄钟"><header><h2>番茄钟</h2><span data-pomodoro-status></span></header><div class="swpd__clock" role="timer" aria-live="off"><strong data-pomodoro-time></strong></div><div class="swpd__phases" role="group" aria-label="计时阶段"><button type="button" data-pomodoro-action="focus" aria-pressed="true"></button><button type="button" data-pomodoro-action="break" aria-pressed="false"></button></div><p class="swpd__target" data-pomodoro-target></p><div class="swpd__controls"><button type="button" class="swpd__primary" data-pomodoro-action="toggle">开始</button><button type="button" data-pomodoro-action="reset">重置</button></div><p class="swpd__error" role="alert" hidden></p><p class="swpd__save" role="status" aria-live="polite"></p><footer><p>收起侧栏后计时继续。关闭思源或休眠期间不保证提示。</p></footer></section>';
  const root=container.firstElementChild,time=root.querySelector('[data-pomodoro-time]'),status=root.querySelector('[data-pomodoro-status]'),target=root.querySelector('[data-pomodoro-target]'),toggle=root.querySelector('[data-pomodoro-action="toggle"]'),error=root.querySelector('[role="alert"]'),saved=root.querySelector('.swpd__save');
  const form=container.ownerDocument.createElement('form');form.className='swpd__settings';form.setAttribute('aria-label','侧栏计时时长');
  form.innerHTML='<div class="swpd__durations"><label>专注分钟<input type="number" name="focusMinutes" min="1" max="180" step="1" required></label><label>休息分钟<input type="number" name="breakMinutes" min="1" max="60" step="1" required></label></div><p class="swpd__draft" role="status" hidden></p><p class="swpd__apply-hint">应用时长会重置本轮计时，保留当前关联任务。</p><button type="submit" data-pomodoro-apply>应用时长并重置本轮</button><button type="button" data-pomodoro-action="discard" hidden>撤销未应用时长</button>';
  root.insertBefore(form,error);
  const fields=['focusMinutes','breakMinutes'],inputs=Object.fromEntries(fields.map(name=>[name,form.querySelector(`[name="${name}"]`)])),draft=form.querySelector('.swpd__draft'),discard=form.querySelector('[data-pomodoro-action="discard"]'),applyButton=form.querySelector('[type="submit"]');
  const taskLabel=container.ownerDocument.createElement('label');taskLabel.className='swpd__task-picker';taskLabel.innerHTML='关联任务<select name="target" aria-label="侧栏关联任务"></select><button type="button" data-pomodoro-action="refresh-tasks">刷新任务</button><small class="swpd__task-context"></small><small class="swpd__task-error" role="alert" hidden></small>';
  form.insertBefore(taskLabel,draft);const taskSelect=taskLabel.querySelector('select'),taskInfo=taskLabel.querySelector('.swpd__task-context'),taskError=taskLabel.querySelector('.swpd__task-error');
  applyButton.textContent='应用设置并重置本轮';discard.textContent='撤销未应用设置';
  const currentBook=()=>options.getNotebookId?options.getNotebookId()||null:context?.notebookId||null;
  const targetKey=value=>JSON.stringify(value||null);
  function taskOptions(){
    const config=getPomodoroConfiguration(),previous=taskDirty?taskSelect.value:null;taskSelect.innerHTML='';
    const add=(value,title)=>{const option=container.ownerDocument.createElement('option');option.value=value;option.textContent=title;taskSelect.append(option);};
    add('', '不关联任务');if(config.target)add('__keep__',`保留当前关联：${config.target.title}${config.target.notebookId!==context?.notebookId?'（其他笔记本）':''}`);
    for(const task of context?.tasks||[])add(task.id,task.title);
    if(taskDirty&&previous&&![...taskSelect.querySelectorAll('option')].some(node=>node.value===previous))add(previous,'原选择已失效，请重新选择');
    taskSelect.value=taskDirty?previous:config.target?'__keep__':'';
  }
  function validateContext(value){
    if(!value||!Array.isArray(value.tasks))throw new Error('任务列表响应无效');
    return {...value,notebookId:value.notebookId||null,tasks:value.tasks.filter(task=>task?.kind==='task'&&task.status!=='done'&&/^\d{14}-[a-z0-9]{7}$/.test(task.id)&&typeof task.title==='string')};
  }
  async function refresh(){
    if(disposed)return;const request=++generation;loading=true;contextValid=false;render();
    try{const value=validateContext(options.loadContext?await options.loadContext():{notebookId:null,notebookName:'',tasks:[]});if(disposed||request!==generation)return;if(options.getNotebookId&&(options.getNotebookId()||null)!==value.notebookId)throw new Error('数据笔记本已切换，请刷新任务');context=value;contextValid=true;taskError.hidden=true;taskInfo.textContent=value.notebookId?`${value.notebookName||'当前笔记本'} · ${value.tasks.length} 项未完成任务`:'配置数据笔记本后可选择任务；仍可调整时长和计时。';taskOptions();}
    catch(failure){if(!disposed&&request===generation){taskError.textContent=`读取任务失败：${failure?.message||'请重试'}。旧列表仅供查看，请刷新后再关联。`;taskError.hidden=false;}}
    finally{if(!disposed&&request===generation){loading=false;render();}}
  }
  let reflected=getPomodoroConfiguration(),externalChange=false;fields.forEach(name=>{inputs[name].value=String(reflected[name]);});
  function updateDraft(){
    const config=getPomodoroConfiguration(),dirty=taskDirty||fields.some(name=>inputs[name].value!==String(config[name]));
    form.dataset.workbenchDraft=String(dirty);draft.hidden=!dirty;discard.hidden=!dirty;
    draft.textContent=externalChange?'其他视图已调整设置；保留了你的未应用输入。':'设置尚未应用；计时仍使用当前已应用的设置。';
    if(!dirty)externalChange=false;
  }
  if(options.onOpenWorkbench){const button=container.ownerDocument.createElement('button');button.type='button';button.dataset.pomodoroAction='open';button.className='swpd__open';button.textContent='打开工作台';root.querySelector('footer').prepend(button);}
  function render(){
    if(disposed)return;
    const snapshot=getPomodoroState(),config=getPomodoroConfiguration(),seconds=Math.ceil(snapshot.remainingMs/1000);
    if(targetKey(config.target)!==targetKey(reflected.target))taskOptions();
    for(const name of fields){if(config[name]!==reflected[name]){if(inputs[name].value===String(reflected[name]))inputs[name].value=String(config[name]);else externalChange=true;}}
    reflected=config;updateDraft();
    time.textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
    status.textContent=snapshot.status==='running'?(snapshot.phase==='focus'?'正在专注':'正在休息'):snapshot.status==='paused'?'已暂停':snapshot.status==='finished'?'本轮完成':snapshot.phase==='focus'?'准备专注':'准备休息';
    toggle.textContent=snapshot.status==='running'?'暂停':snapshot.status==='paused'?'继续':'开始';
    target.textContent=config.target?`关联任务：${config.target.title}`:'未关联任务';
    for(const phase of ['focus','break']){const button=root.querySelector(`[data-pomodoro-action="${phase}"]`);button.textContent=`${phase==='focus'?'专注':'休息'} ${phase==='focus'?config.focusMinutes:config.breakMinutes} 分钟`;button.setAttribute('aria-pressed',String(snapshot.phase===phase));}
    root.querySelectorAll('[data-pomodoro-action]').forEach(button=>{button.disabled=busy;});
    fields.forEach(name=>{inputs[name].disabled=busy;});applyButton.disabled=busy||snapshot.status==='running';
    taskSelect.disabled=busy||loading;taskLabel.querySelector('[data-pomodoro-action="refresh-tasks"]').disabled=busy||loading;
    form.querySelector('.swpd__apply-hint').textContent=snapshot.status==='running'?'计时正在运行，请先暂停，再应用时长。':'应用时长会重置本轮计时，保留当前关联任务。';
  }
  async function apply(event){
    event.preventDefault();if(disposed||busy)return;error.hidden=true;saved.textContent='';
    if(getPomodoroState().status==='running'){error.textContent='计时正在运行，请先暂停，再应用时长。';error.hidden=false;return;}
    let applied=false;busy=true;render();
    try{
      const focusMinutes=Number(inputs.focusMinutes.value),breakMinutes=Number(inputs.breakMinutes.value);
      if(!Number.isInteger(focusMinutes)||focusMinutes<1||focusMinutes>180||!Number.isInteger(breakMinutes)||breakMinutes<1||breakMinutes>60)throw new Error('专注为 1–180 分钟，休息为 1–60 分钟，均需整数');
      let selectedTarget;
      if(taskDirty){
        const selected=taskSelect.value;
        if(!selected)selectedTarget=null;
        else if(selected!=='__keep__'){
          if(!contextValid||!context?.notebookId||context.notebookId!==currentBook())throw new Error('任务列表已失效或笔记本已切换，请刷新任务后重新选择');
          const expectedBook=context.notebookId;
          const fresh=validateContext(await options.loadContext());if(disposed)return;
          if(fresh.notebookId!==expectedBook||currentBook()!==expectedBook)throw new Error('数据笔记本已切换，请刷新任务后重新选择');
          const task=fresh.tasks.find(value=>value.id===selected);if(!task)throw new Error('所选任务已完成、删除或不再可用，请刷新任务后重新选择');
          selectedTarget={notebookId:expectedBook,id:task.id,title:task.title};
        }
      }
      const config=getPomodoroConfiguration(),next={...config,focusMinutes,breakMinutes,...(selectedTarget!==undefined?{target:selectedTarget}:{})};
      const state=configurePomodoro(next);applied=true;taskDirty=false;reflected=getPomodoroConfiguration();externalChange=false;taskOptions();updateDraft();render();
      if(!options.persistSnapshot)throw new Error('保存接口尚未配置');await options.persistSnapshot(state);
      if(!disposed)saved.textContent='时长已应用，本轮已重置';
    }catch(failure){if(!disposed){error.textContent=applied?`时长已生效，但保存失败：${failure?.message||'请重试'}。重启可能丢失本次设置。`:failure?.message||'时长无效';error.hidden=false;}}
    finally{busy=false;render();}
  }
  async function click(event){
    const button=event.target.closest('button');if(disposed||busy||!button||!root.contains(button)||button.disabled)return;
    const action=button.dataset.pomodoroAction;if(!action)return;
    error.hidden=true;saved.textContent='';
    if(action==='refresh-tasks')return refresh();
    if(action==='discard'){reflected=getPomodoroConfiguration();fields.forEach(name=>{inputs[name].value=String(reflected[name]);});taskDirty=false;taskOptions();externalChange=false;updateDraft();return;}
    if(action==='open'){try{await options.onOpenWorkbench?.();}catch(failure){if(!disposed){error.textContent=failure?.message||'打开工作台失败';error.hidden=false;}}return;}
    busy=true;
    try{
      const state=controlPomodoro(action==='toggle'?(getPomodoroState().status==='running'?'pause':'start'):action);render();
      if(!options.persistSnapshot)throw new Error('保存接口尚未配置');
      await options.persistSnapshot(state);if(!disposed)saved.textContent='计时状态已保存';
    }catch(failure){if(!disposed){error.textContent=`当前计时已生效，但保存失败：${failure?.message||'请重试'}。重启可能丢失本次进度。`;error.hidden=false;}}
    finally{busy=false;render();}
  }
  const input=event=>{if(disposed)return;if(event.target===taskSelect)taskDirty=taskSelect.value!=='__keep__';updateDraft();};
  root.addEventListener('click',click);form.addEventListener('submit',apply);form.addEventListener('input',input);form.addEventListener('change',input);const unsubscribe=subscribePomodoro(render);
  taskOptions();void refresh();
  return {refresh,dispose(){if(disposed)return;disposed=true;++generation;unsubscribe();root.removeEventListener('click',click);form.removeEventListener('submit',apply);form.removeEventListener('input',input);form.removeEventListener('change',input);}};
}
