const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const BATCH_LIMIT=20;
/** Explicit preview, then bounded sequential writes. No mount-time reads or background queue. */
export function mountCategoryOrganizer(container,options={}){
  let disposed=false,busy=false,executing=false,stopRequested=false,generation=0,plan=null,valid=false,locked=false;
  let rows=[],pageRows=[],history=[];
  container.innerHTML=`<section class="swco" aria-label="按分类整理已有任务与日程"><p>先预览文档当前位置和分类目录，再确认整理。每次最多整理 20 条；不会自动执行下一批。</p><div class="swco__actions"><button type="button" data-organizer-action="preview">预览整理</button><button type="button" data-organizer-action="execute" disabled>确认整理</button><button type="button" data-organizer-action="stop" disabled>停止后续条目</button></div><p class="swco__status" role="status" aria-live="polite">尚未预览，未移动任何文档。</p><p class="swco__error" role="alert" hidden></p><div class="swco__preview"></div><ol class="swco__results" aria-label="本次设置会话整理结果"></ol></section>`;
  const root=container.firstElementChild,status=root.querySelector('[role="status"]'),error=root.querySelector('[role="alert"]'),preview=root.querySelector('.swco__preview'),results=root.querySelector('.swco__results');
  const button=action=>root.querySelector(`[data-organizer-action="${action}"]`);
  function available(){try{return options.isAvailable?.()!==false;}catch{return false;}}
  function sameNotebook(){try{return !options.getNotebookId||options.getNotebookId()===plan?.notebookId;}catch{return false;}}
  const pending=()=>rows.filter(row=>row.state==='pending');
  const chosen=()=>pageRows.filter(row=>row.state==='pending'&&row.selected);
  function fail(message){error.textContent=message||'';error.hidden=!message;}
  function controls(){if(disposed)return;const ready=available()&&sameNotebook();button('preview').disabled=busy||!available();button('execute').disabled=busy||!valid||locked||!ready||chosen().length===0;button('execute').textContent=`确认整理${chosen().length?'（本批 '+chosen().length+' 条）':''}`;button('stop').disabled=!executing||stopRequested;root.setAttribute('aria-busy',String(busy));root.querySelectorAll('[data-organizer-select]').forEach(input=>{input.disabled=busy||!valid||locked||!ready||input.dataset.state!=='pending';});}
  function render(){if(disposed)return;
    const count=pending().length,done=rows.filter(row=>row.state==='done').length;
    preview.innerHTML=plan?`<p class="swco__count">笔记本：${escape(plan.notebookName||plan.notebookId)} · 共 ${rows.length} 条 · 已完成 ${done} 条 · 待整理 ${count} 条${!valid?' · 预览已失效，需重新预览':''}</p>${rows.length>BATCH_LIMIT?'<p>本次仅显示前 20 条。其余条目请在本批完成后重新预览、再次确认。</p>':''}<div class="swco__table-wrap"><table><thead><tr><th>选择</th><th>类型 / 标题</th><th>分类</th><th>当前位置</th><th>目标目录</th><th>状态</th></tr></thead><tbody>${pageRows.map(row=>`<tr data-organizer-id="${escape(row.item.id)}"><td><input type="checkbox" data-organizer-select="${escape(row.item.id)}" data-state="${row.state}" aria-label="整理：${escape(row.item.title)}" ${row.selected?'checked':''}></td><td><small>${row.item.kind==='task'?'任务':'日程'}</small> ${escape(row.item.title)}<small class="swco__id">${escape(row.item.id)}</small></td><td>${escape(row.item.category||'未分类')}</td><td>${escape(row.item.currentDisplayPath??row.item.currentPath)}</td><td>${escape(row.item.targetDisplayPath??row.item.targetPath)}</td><td>${({pending:'待整理',running:'整理中',done:'已完成',failed:'停止，需核查'})[row.state]}</td></tr>`).join('')}</tbody></table></div>`:'';
    results.innerHTML=history.map(entry=>`<li>${escape(entry)}</li>`).join('');controls();
  }
  async function readPlan(){if(disposed||busy)return;if(!available()){fail('当前无法读取，请先选择可用的数据笔记本。');controls();return;}
    busy=true;valid=false;fail('');status.textContent='正在只读预览，尚未执行整理…';controls();const request=++generation;
    let before;try{before=options.getNotebookId?.();const next=await options.plan();if(disposed||request!==generation)return;
      if(!available()||(options.getNotebookId&&(options.getNotebookId()!==before||next?.notebookId!==before)))throw new Error('数据笔记本已变化，请重新预览。');
      if(!next||typeof next.notebookId!=='string'||!next.notebookId||!Array.isArray(next.items))throw new Error('整理预览响应无效');
      const ids=new Set();for(const item of next.items){if(!item||typeof item.id!=='string'||!item.id||ids.has(item.id)||!['task','event'].includes(item.kind)||typeof item.title!=='string'||typeof item.currentPath!=='string'||typeof item.targetPath!=='string')throw new Error('预览条目不完整或重复，未执行整理。');ids.add(item.id);}
      plan=next;rows=next.items.map(item=>({item,state:'pending',selected:false}));pageRows=rows.slice(0,BATCH_LIMIT);pageRows.forEach(row=>{row.selected=true;});valid=true;locked=false;status.textContent=rows.length?`预览完成，共 ${rows.length} 条。请核对目录，点击确认后仅执行本批最多 20 条。`:'预览完成，没有需要整理的任务或日程。';
    }catch(reason){if(!disposed&&request===generation){valid=false;fail(`预览失败：${reason?.message||'请重新预览'}`);status.textContent='预览未完成，禁止执行整理。';}}
    finally{if(!disposed&&request===generation){busy=false;render();}}
  }
  async function executeBatch(){if(disposed||busy||locked||!valid)return;
    if(!available()||!sameNotebook()){valid=false;fail('数据笔记本或可用状态已变化，请重新预览后再确认。');render();return;}
    const batch=chosen().slice(0,BATCH_LIMIT);if(!batch.length)return;
    busy=true;executing=true;stopRequested=false;fail('');++generation;render();
    try{for(const row of batch){
      if(disposed||stopRequested)break;
      if(!available()||!sameNotebook()){valid=false;locked=true;fail('数据笔记本或可用状态已变化，已停止后续条目。请重新预览核查。');break;}
      row.state='running';status.textContent=`正在整理：${row.item.title}。当前条目完成后可停止。`;render();
      try{const receipt=await options.execute(row.item);if(disposed)return;
        if(receipt?.id!==row.item.id||receipt.organized!==true)throw new Error('未收到确认整理成功的回执');
        row.state='done';history.push(`已完成：${row.item.title}（${row.item.id}）`);
        if(!available()||!sameNotebook()){valid=false;locked=true;fail('当前条目已确认完成，但数据笔记本或可用状态已变化，后续条目已停止。请重新预览。');break;}
      }catch(reason){if(disposed)return;row.state='failed';locked=true;valid=false;history.push(`需核查：${row.item.title}（${row.item.id}）`);fail(`整理已停止：${reason?.message||'结果未确认'}。待核查 ID：${row.item.id}。已完成结果保留，不会自动重试；请核查后重新预览。`);break;}
      render();
    }}finally{if(!disposed){busy=false;executing=false;if(pending().length)valid=false;status.textContent=locked?'整理已停止，请核查提示中的文档。':stopRequested?`已停止后续条目，剩余 ${pending().length} 条。完成记录已保留；请重新预览后再次确认。`:pending().length?`本批已完成，剩余 ${pending().length} 条。请重新预览后确认下一批。`:'本次预览中的条目已全部整理完成。';render();}}
  }
  function click(event){const node=event.target.closest('[data-organizer-action]');if(!node||node.disabled||!root.contains(node)||disposed)return;
    if(node.dataset.organizerAction==='preview')void readPlan();
    else if(node.dataset.organizerAction==='execute')void executeBatch();
    else if(node.dataset.organizerAction==='stop'&&executing){stopRequested=true;status.textContent='已请求停止，正在等待当前条目的结果，不再执行后续条目。';controls();}
  }
  function change(event){const input=event.target;if(!input.matches?.('[data-organizer-select]')||disposed||busy||!valid||locked)return;const row=pageRows.find(row=>row.item.id===input.dataset.organizerSelect);if(row&&row.state==='pending')row.selected=input.checked;controls();}
  root.addEventListener('click',click);root.addEventListener('change',change);controls();
  return {refreshAvailability(){if(disposed)return;if(plan&&(!available()||!sameNotebook())){valid=false;fail('数据笔记本或可用状态已变化，请重新预览。');}render();},dispose(){disposed=true;++generation;stopRequested=true;root.removeEventListener('click',click);root.removeEventListener('change',change);}};
}
