/** Native Custom callbacks must be registered synchronously, before plugin onload awaits. */
export function createNativeWorkbenchHost({register,open,mount,onError=()=>{}}) {
  const hosts=new Map();let disposed=false,opening=null;
  register({init:function(){
    if(disposed)return;
    const model=this,host={model,alive:true,cleanup:null};hosts.set(model,host);
    Promise.resolve().then(()=>mount(model)).then(cleanup=>{
      if(!host.alive||disposed)cleanup?.();else host.cleanup=cleanup;
    }).catch(error=>{if(host.alive&&!disposed)onError(error,model);});
  },destroy:function(){
    const host=hosts.get(this);if(!host)return;
    host.alive=false;host.cleanup?.();hosts.delete(this);
  }});
  return {hosts,
    isAlive:model=>!disposed&&Boolean(hosts.get(model)?.alive),
    open(){
      if(disposed)return Promise.resolve(null);
      const existing=[...hosts.values()].find(host=>host.alive);
      if(existing){existing.model.tab?.headElement?.click();return Promise.resolve(existing.model.tab);}
      if(opening)return opening;
      opening=Promise.resolve().then(()=>disposed?null:open()).finally(()=>{opening=null;});return opening;
    },
    dispose(){disposed=true;for(const host of [...hosts.values()]){host.alive=false;host.cleanup?.();host.model.tab?.close?.();}hosts.clear();},
  };
}

/** Each settings opening receives a fresh draft; selection changes alone never persist. */
export function createNotebookSettingControl({document,getNotebooks,getValue,save}) {
  const root=document.createElement('div');root.className='fn__flex-column';
  const select=document.createElement('select');select.className='b3-select';select.setAttribute('aria-label','工作台数据笔记本');
  const books=getNotebooks().filter(book=>!book.closed);
  for(const book of [{id:'',name:'不配置'},...books]){
    const option=document.createElement('option');option.value=book.id;option.textContent=book.name||book.id;select.append(option);
  }
  select.value=books.some(book=>book.id===getValue())?getValue():'';
  const button=document.createElement('button');button.type='button';button.className='b3-button';button.textContent='保存笔记本设置';
  const status=document.createElement('p');status.setAttribute('role','status');
  let saving=false;
  button.addEventListener('click',async()=>{
    if(saving)return;
    const id=select.value;
    if(id&&!getNotebooks().some(book=>book.id===id&&!book.closed)){status.textContent='该笔记本已不可用，请重新打开设置';return;}
    saving=true;button.disabled=true;select.disabled=true;status.textContent='正在保存…';
    try{await save(id);status.textContent='已保存；工作台将使用此笔记本，原文档保持原位置';}
    catch(error){status.textContent=error?.message||'保存失败，请重试';}
    finally{saving=false;button.disabled=false;select.disabled=false;}
  });
  root.append(select,button,status);return root;
}

export function hasWorkbenchDraft(element) {
  return Boolean(element.querySelector('.swb__modal-host form,.swb-notes__form,.swp__form,.swp__batch-form,.swrc__form,.swfc__form[data-workbench-draft="true"],.swj [data-job-draft="true"],.swj[data-job-busy="true"],.swcal form,.swtc form,.swtb iframe,.swus[data-search-draft="true"],.swa__composer[data-workbench-draft]')) ||
      Boolean(element.querySelector('.swci__form[data-workbench-draft],[data-projects-draft="true"],[data-tree-draft="true"],[data-record-page-open="true"]')) ||
    [...element.querySelectorAll('.swa textarea')].some(input=>Boolean(input.value.trim()));
}

export async function saveCheckedData(save,name,value,{timeoutMs=8000}={}) {
  let timeout;
  try {
    const result=await Promise.race([Promise.resolve().then(()=>save(name,value)),new Promise((resolve,reject)=>{
      timeout=setTimeout(()=>{const error=new Error('保存结果未确认：等待思源响应超时，请重新启用插件后核查');error.commitState='unknown';reject(error);},timeoutMs);
    })]);
    if(result && typeof result.code==='number' && result.code!==0) throw new Error(result.msg||'思源没有保存插件设置');
    return result;
  } finally {clearTimeout(timeout);}
}
