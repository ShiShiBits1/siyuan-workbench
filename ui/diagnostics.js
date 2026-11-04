const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const number=value=>count(value)===null?'—':String(value);
const version=value=>typeof value==='string'&&/^\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(value)?value:'unknown';
const states={awaiting_review:'待验收',needs_input:'待补充',failed:'失败',running:'执行中或待核查'};

/** Deliberately rebuild the export from safe scalar fields; never serialize load data. */
export function diagnosticSummary(data,{fresh=true}={}){
  return {version:version(data?.version),appVersion:version(data?.appVersion),notebook:{id:/^\d{14}-[a-z0-9]{7}$/.test(data?.notebook?.id||'')?data.notebook.id:null},readStatus:fresh?'ok':'error',checks:(Array.isArray(data?.checks)?data.checks:[]).map((check,index)=>({index,status:check?.status==='ok'?'ok':'error',count:check?.status==='ok'?count(check?.count):null})),jobs:Object.fromEntries(Object.keys(states).map(state=>[state,count(data?.jobs?.[state])])),history:{unknownCompletion:count(data?.history?.unknownCompletion),totalTasks:count(data?.history?.totalTasks)}};
}

/** Read-only health panel. Mounting and navigation never start reads or recovery. */
export function mountDiagnostics(container,options={}){
  let disposed=false,busy=false,generation=0,data=null,fresh=false;
  const doc=container.ownerDocument;
  container.innerHTML=`<section class="swd" aria-label="运行检查"><header class="swd__head"><div data-workbench-page-intro><h2>运行检查</h2><p>确认数据是否可读，找到需要继续处理的工作。</p></div><div><button type="button" data-diagnostic-action="refresh">刷新检查</button><button type="button" data-diagnostic-action="copy" disabled>复制诊断摘要</button></div></header><p class="swd__notice">仅在点击刷新时读取数据，不调用模型，也不恢复或重新执行委托。</p><p class="swd__error" role="alert" hidden></p><p class="swd__status" role="status" aria-live="polite">尚未读取，点击“刷新检查”开始。</p><div class="swd__content"><p class="swd__empty">尚无检查结果。</p></div><footer>复制内容仅包含版本、笔记本 ID、数量与检查状态。不会包含模型密钥、访问令牌、服务地址或原始错误参数。</footer></section>`;
  const root=container.firstElementChild,content=root.querySelector('.swd__content'),status=root.querySelector('[role="status"]'),error=root.querySelector('[role="alert"]'),copy=root.querySelector('[data-diagnostic-action="copy"]'),refreshButton=root.querySelector('[data-diagnostic-action="refresh"]');
  const fail=message=>{if(disposed)return;error.textContent=message||'';error.hidden=!message;};
  function render(){
    if(disposed||!data)return;
    const checks=Array.isArray(data.checks)?data.checks:[],notes=Array.isArray(data.notes)?data.notes:[];
    content.innerHTML=`<dl class="swd__identity"><div><dt>插件版本</dt><dd>${escape(data.version||'未知')}</dd></div><div><dt>思源版本</dt><dd>${escape(data.appVersion||'未知')}</dd></div><div><dt>数据笔记本</dt><dd>${escape(data.notebook?.name||'未配置')}<small>${escape(data.notebook?.id||'')}</small></dd></div></dl><section aria-label="数据读取检查"><h3>数据读取</h3>${checks.length?`<ul class="swd__checks">${checks.map(check=>`<li><div><strong>${escape(check?.label||'未命名检查')}</strong><span class="swd__result ${check?.status==='ok'?'is-ok':'is-error'}">${check?.status==='ok'?'可读':'读取失败'}</span></div>${check?.count!==undefined?`<p>记录数量：${check.status==='ok'?number(check.count):'—'}</p>`:''}${check?.detail?`<p>${escape(check.detail)}</p>`:''}</li>`).join('')}</ul>`:'<p class="swd__warning">没有返回检查项目，无法判断数据是否完整。</p>'}</section><section aria-label="需要处理的委托"><h3>继续处理委托</h3><div class="swd__jobs">${Object.entries(states).map(([state,label])=>`<button type="button" data-diagnostic-jobs="${state}" ${count(data.jobs?.[state])===null?'disabled':''}><span>${label}</span><strong>${number(data.jobs?.[state])}</strong></button>`).join('')}</div><p>点击查看对应委托；中断任务需手动核查保存结果，检查不会自动重放。</p></section><section class="swd__history" aria-label="完成记录覆盖"><h3>历史覆盖</h3><p>任务总数 <strong>${number(data.history?.totalTasks)}</strong>；缺少可靠完成时间的任务 <strong>${number(data.history?.unknownCompletion)}</strong>。</p><p>历史缺少完成记录时保持未知，不以最后编辑时间代替完成时间。</p></section>${notes.length?`<section class="swd__notes" aria-label="环境与使用说明"><h3>环境与使用说明</h3><ul>${notes.map(note=>`<li>${escape(note)}</li>`).join('')}</ul></section>`:''}`;
  }
  async function refresh(){
    if(disposed||busy)return;busy=true;refreshButton.disabled=true;copy.disabled=true;const request=++generation;status.textContent='正在读取检查结果…';fail('');
    try{const result=await options.load();if(disposed||request!==generation)return;if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('检查响应无效');data=result;fresh=true;render();status.textContent=Array.isArray(data.checks)&&data.checks.length&&data.checks.every(check=>check?.status==='ok')?'读取检查完成。':'检查完成，存在失败或缺失的项目，请逐项核查。';}
    catch(failure){if(disposed||request!==generation)return;fresh=false;fail(`读取检查失败：${failure?.message||'请重试'}。${data?'保留上次读取的结果，数量可能已变化。':'尚无可确认的数据，未将失败计为 0。'}`);status.textContent=data?'显示上次读取结果，请稍后重试。':'尚未取得检查结果。';}
    finally{if(!disposed&&request===generation){busy=false;refreshButton.disabled=false;copy.disabled=!data;}}
  }
  async function click(event){
    const button=event.target.closest('button');if(disposed||!button||!root.contains(button)||button.disabled)return;
    try{if(button.dataset.diagnosticJobs){if(typeof options.onOpenJobs!=='function')throw new Error('委托列表暂时无法打开，请重新打开工作台');await options.onOpenJobs(button.dataset.diagnosticJobs);return;}
      if(button.dataset.diagnosticAction==='refresh'){await refresh();return;}
      if(button.dataset.diagnosticAction==='copy'){const clipboard=doc.defaultView?.navigator?.clipboard,write=options.copyText||clipboard?.writeText?.bind(clipboard);if(typeof write!=='function')throw new Error('剪贴板不可用，请允许剪贴板访问后重试');await write(JSON.stringify(diagnosticSummary(data,{fresh}),null,2));if(!disposed)status.textContent=fresh?'诊断摘要已复制。':'已复制上次结果摘要，已标记本次读取失败。';}
    }catch(failure){fail(failure?.message||'操作失败，请重试');}
  }
  root.addEventListener('click',click);
  return {refresh,dispose(){if(disposed)return;disposed=true;++generation;root.removeEventListener('click',click);}};
}
