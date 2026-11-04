import {isValidNodeID} from '../data/node-id.js';
const batches=new Set();
const eligible=new Set(['draft','changes_requested','failed']);
/** A bounded, explicit queue over already-persisted assignments. Never creates jobs or retries writes. */
export function createJobBatch({repository,runner}) {
  let controller=null;
  return {
    get running(){return Boolean(controller);},
    stop(){controller?.abort();},
    async run(ids,{signal,onUpdate=()=>{}}={}) {
      if(!Array.isArray(ids)||ids.length<1||ids.length>5||new Set(ids).size!==ids.length||ids.some(id=>!isValidNodeID(id)))throw new Error('请明确选择1至5项不同的委托');
      if(batches.has(repository.notebookId))throw new Error('当前笔记本已有批次执行中，请先停止或等待完成');
      batches.add(repository.notebookId);controller=new AbortController();const current=controller;
      const stop=()=>current.abort();signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
      const results=ids.map(id=>({id,state:'queued',deliverables:[]}));
      const notify=async()=>{try{await onUpdate(results.map(item=>({...item,deliverables:[...item.deliverables]})));}catch{/* UI callbacks cannot change persisted execution outcomes. */}};
      try {
        // Validate every item before starting the first model request.
        for(const id of ids){const job=await repository.get(id);if(!eligible.has(job.state))throw new Error('委托状态已变化，请刷新批次；仅草稿、退回和失败项可执行');}
        await notify();
        for(const item of results){
          if(current.signal.aborted)break;item.state='running';await notify();
          try {const job=await runner.run(item.id,'',{signal:current.signal});item.state=job.state;item.deliverables=job.deliverables||[];}
          catch(error){item.state=current.signal.aborted?'stopped':'failed';item.error=error.message;item.commitState=error.commitState||null;}
          await notify();
        }
        for(const item of results)if(item.state==='queued')item.state='not_started';await notify();return results;
      } finally {signal?.removeEventListener('abort',stop);controller=null;batches.delete(repository.notebookId);}
    },
  };
}
