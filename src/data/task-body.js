import {stableNodeID,isValidNodeID} from './node-id.js';

export function createTaskBodyRepository({notebookId,post,getTask}) {
  const pending=new Map();
  async function api(path,body) {
    const result=await post(path,body);
    if(result?.code!==0)throw new Error(result?.msg||'无法读取任务正文');
    return result.data;
  }
  async function ensure(taskId) {
    if(!isValidNodeID(taskId))throw new Error('任务标识无效');
    if(pending.has(taskId))return pending.get(taskId);
    const operation=prepare(taskId).finally(()=>pending.delete(taskId));
    pending.set(taskId,operation);
    return operation;
  }
  async function prepare(taskId) {
    const task=await getTask(taskId);
    if(task.kind!=='task')throw new Error('只能打开任务正文');
    const parent=await api('/api/filetree/getPathByID',{id:taskId});
    if(parent?.notebook!==notebookId||!parent.path?.endsWith('.sy'))throw new Error('任务已移出当前笔记本');
    const bodyId=stableNodeID(taskId+':workbench-task-body');
    const marker='<!-- workbench-task-body:'+taskId+' -->';
    let existing=await post('/api/block/getBlockInfo',{id:bodyId});
    if(existing?.code!==0) {
      try {
        await api('/api/filetree/createDocByParent',{
          notebook:notebookId,parentID:taskId,id:bodyId,
          title:{format:'plain',text:'任务正文'},
          markdown:marker+'\n\n'+(task.detail||''),
        });
      } catch(failure) {
        existing=await post('/api/block/getBlockInfo',{id:bodyId});
        if(existing?.code!==0)throw failure;
      }
      await api('/api/sqlite/flushTransaction',{});
    }
    const [location,attrs]=await Promise.all([
      api('/api/filetree/getPathByID',{id:bodyId}),
      api('/api/attr/getBlockAttrs',{id:bodyId}),
    ]);
    if(location?.notebook!==notebookId||location.path!==parent.path.slice(0,-3)+'/'+bodyId+'.sy')throw new Error('任务正文位置已变化，请打开原文核查');
    if(attrs?.['custom-workbench-task-body']!==taskId) {
      const raw=await api('/api/block/getBlockKramdown',{id:bodyId});
      if(raw?.id!==bodyId||!raw.kramdown?.includes(marker))throw new Error('任务正文标识已被占用');
      await api('/api/attr/setBlockAttrs',{id:bodyId,attrs:{'custom-workbench-task-body':taskId}});
    }
    const children=await api('/api/block/getChildBlocks',{id:bodyId});
    const first=Array.isArray(children)?children[0]:null;
    if(first?.type==='p'&&first.content===marker&&isValidNodeID(first.id)) {
      await api('/api/block/deleteBlock',{id:first.id});
      await api('/api/sqlite/flushTransaction',{});
    }
    return {...task,bodyId};
  }
  return {ensure};
}
