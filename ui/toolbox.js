const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function mountToolbox(container,{manager}) {
  let disposed=false,busy=false,generation=0,state={catalog:[],installed:[]},preview=null,query='';
  container.innerHTML=`<section class="swtb" aria-label="扩展工具箱"><header><div data-workbench-page-intro><h2>扩展工具箱</h2><p>统一工具目录，按需安装，工具在这里打开。</p></div><button type="button" data-toolbox="import">导入工具包</button><input type="file" class="swtb__file" accept=".zip,application/zip" hidden></header><p class="swtb__error" role="alert" hidden></p><p class="swtb__status" role="status" aria-live="polite"></p><div class="swtb__preview"></div><div class="swtb__directory"><label class="swtb__search">查找工具<input type="search" aria-label="查找工具" placeholder="名称、分类或说明"></label><div class="swtb__list"></div></div><div class="swtb__runtime" hidden></div></section>`;
  const root=container.querySelector('.swtb'),list=root.querySelector('.swtb__list'),runtime=root.querySelector('.swtb__runtime'),directory=root.querySelector('.swtb__directory'),error=root.querySelector('.swtb__error'),status=root.querySelector('.swtb__status'),previewHost=root.querySelector('.swtb__preview'),file=root.querySelector('.swtb__file');
  const button=(action,label,id,blocked=false)=>`<button type="button" data-toolbox="${action}" data-tool-id="${esc(id)}" ${busy||blocked?'disabled':''}>${label}</button>`;
  function setError(value=''){error.textContent=value;error.hidden=!value;}
  function draw(){
    if(disposed)return;
    const shown=state.catalog.filter(item=>[item.manifest.name,item.manifest.description,item.manifest.category].join(' ').toLowerCase().includes(query.toLowerCase()));
    list.innerHTML=shown.length?shown.map(item=>{const m=item.manifest,installed=Boolean(item.installedVersion);return `<article class="swtb__card"><header><h3>${esc(m.name)}</h3><span>${installed?(item.enabled?'已启用':'已停用'):'未安装'}</span></header><p>${esc(m.description||'暂无说明')}</p><dl><div><dt>版本</dt><dd>${esc(item.installedVersion||m.version)}</dd></div><div><dt>作者</dt><dd>${esc(m.author||'未提供')}</dd></div><div><dt>分类</dt><dd>${esc(m.category||'通用')}</dd></div></dl><footer>${installed?`${button('open','打开工具',m.id,!item.enabled)}${button(item.enabled?'disable':'enable',item.enabled?'停用':'启用',m.id)}${item.hasRollback?button('rollback','回滚上一版',m.id):''}${button('ask-remove','卸载',m.id)}`:button(item.source==='builtin'?'builtin':'import',item.source==='builtin'?'安装':'重新导入安装',m.id)}</footer></article>`;}).join(''):`<p class="swtb__empty">${query?'没有匹配的工具。':'暂无工具，可导入可信的自研工具包。'}</p>`;
    root.querySelector('[data-toolbox="import"]').disabled=busy;
    file.disabled=busy;
  }
  function stopRuntime(){runtime.replaceChildren();runtime.hidden=true;directory.hidden=false;}
  function showPreview(){
    if(!preview){previewHost.innerHTML='';return;}
    const m=preview.manifest;
    previewHost.innerHTML=`<section class="swtb__install" aria-label="确认安装工具"><h3>${esc(m.name)}</h3><p>${esc(m.description)}</p><p>版本 ${esc(m.version)} · 作者 ${esc(m.author||'未提供')} · ${preview.fileCount} 个文件</p><p>此工具会运行自定义代码。请只安装你信任的自研工具；安装后由你点击打开。</p>${(preview.warnings||[]).map(w=>`<p>${esc(w)}</p>`).join('')}<footer>${button('confirm-install',preview.action==='upgrade'?'确认升级':'确认安装','')}${button('cancel-install','取消','')}</footer></section>`;
  }
  async function work(operation,success){
    if(disposed||busy)return;
    busy=true;setError();draw();showPreview();const token=++generation;
    try{const next=await operation();if(disposed||token!==generation)return;if(next?.catalog)state=next;else state=manager.list();if(success)status.textContent=success;}
    catch(failure){if(!disposed&&token===generation)setError(failure?.message||'操作未确认，请核查后重试。');}
    finally{if(!disposed&&token===generation){busy=false;draw();showPreview();}}
  }
  async function onClick(event){
    const target=event.target.closest('[data-toolbox]');if(!target||target.disabled||busy)return;
    const action=target.dataset.toolbox,id=target.dataset.toolId;
    if(action==='import'){if(!canHide())return;stopRuntime();file.value='';file.click();return;}
    if(action==='back'){if(canHide())stopRuntime();return;}
    if(action==='cancel-install'){preview=null;showPreview();return;}
    if(action==='ask-remove'){
      stopRuntime();previewHost.innerHTML=`<section class="swtb__install" aria-label="确认卸载工具"><h3>卸载工具？</h3><p>移除已安装的工具包；不会删除工具生成的文档或你下载的文件。</p>${button('remove','确认卸载',id)}${button('cancel-install','保留','')}</section>`;return;
    }
    if(action==='open'){
      const opening=++generation;try{const document=await manager.getToolDocument(id);if(disposed||busy||opening!==generation)return;stopRuntime();runtime.innerHTML=`<header><h3>${esc(document.manifest.name)}</h3>${button('back','返回工具目录','')}</header><p>本次输入临时保留在工具页。返回目录、切换页面或关闭插件会结束运行；请先保存工具生成的结果。</p>`;const frame=container.ownerDocument.createElement('iframe');frame.title=document.manifest.name;frame.setAttribute('sandbox','allow-scripts');frame.srcdoc=document.html;runtime.appendChild(frame);runtime.hidden=false;directory.hidden=true;setError();}
      catch(failure){setError(failure.message||'工具无法打开，请先启用。');}return;
    }
    if(action==='confirm-install'){const token=preview?.token;if(!token)return;await work(async()=>{const next=await manager.install(token);preview=null;return next;},'工具已安装，点击打开即可使用。');return;}
    if(['disable','enable','remove','rollback','builtin'].includes(action)){
      stopRuntime();await work(async()=>{const next=action==='builtin'?await manager.installBuiltin(id):action==='remove'?await manager.uninstall(id):action==='rollback'?await manager.rollback(id):await manager.setEnabled(id,action==='enable');preview=null;return next;},action==='remove'?'工具已卸载，用户文件保留。':'工具状态已保存。');
    }
  }
  async function onFiles(){const picked=file.files?.[0];file.value='';if(!picked||busy||disposed)return;stopRuntime();await work(async()=>{preview=await manager.previewInstall(picked);return manager.list();},'工具包已检查，确认后才会安装。');}
  function onSearch(event){if(event.target.matches('.swtb__search input')){query=event.target.value;draw();}}
  root.addEventListener('click',onClick);file.addEventListener('change',onFiles);root.addEventListener('input',onSearch);
  function canHide(){if(!runtime.querySelector('iframe'))return true;const ask=container.ownerDocument.defaultView?.confirm;return typeof ask==='function'&&ask.call(container.ownerDocument.defaultView,'离开会结束工具运行并清空临时输入，请确认已保存结果。是否继续？');}
  const refresh=()=>work(async()=>{await manager.initialize();return manager.list();});
  void refresh();
  const cleanup=()=>{disposed=true;generation++;stopRuntime();root.removeEventListener('click',onClick);file.removeEventListener('change',onFiles);root.removeEventListener('input',onSearch);container.innerHTML='';};
  cleanup.refresh=refresh;cleanup.canHide=canHide;cleanup.onHide=()=>{generation++;busy=false;preview=null;stopRuntime();showPreview();draw();};cleanup.onShow=refresh;
  return cleanup;
}
