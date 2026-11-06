import {newAgentJob,transitionAgentJob,buildAgentJobPrompt,parseAgentResult} from '../domain/agent-job.js';
import {newNodeID} from '../data/node-id.js';
const active=new Map(),unconfirmed=new Set();
const aborted=signal=>{if(signal?.aborted)throw new DOMException('已停止委托，已保存的成果仍保留','AbortError');};

// A transport may stay pending even after abort. Detach only generation (which
// cannot write a workbench document), never an in-flight repository write.
async function generateUntilStopped(client, input, signal, onToken) {
  aborted(signal);
  let stop;
  const stopped = new Promise((_, reject) => {
    stop = () => reject(new DOMException('已停止生成', 'AbortError'));
    signal.addEventListener('abort', stop, {once:true});
  });
  try {
    return await Promise.race([stopped, client.generate(input, {
      signal,
      onToken: token => { if (!signal.aborted) return onToken?.(token); },
    })]);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

export function createAgentJobRunner({repository,client,plannerRepository,workbenchRepository}={}) {
  const key=id=>repository.notebookId+':'+id;
  async function tracked(id,operation){try{return await operation();}catch(error){if(error.commitState)unconfirmed.add(key(id));throw error;}}
  async function move(job,state,patch={}){
    const next=transitionAgentJob(job,state,patch);
    return repository.patch(job.id,{...patch,state:next.state},{expectedRevision:job.revision});
  }
  async function guarded(id, operation, kind='edit') {
    const jobKey = key(id);
    if (active.has(jobKey)) throw new Error('该委托正在执行，请等待或停止');
    const lock = {kind, controller:new AbortController()};
    active.set(jobKey,lock);
    lock.promise = tracked(id, async () => {
      const job = await repository.get(id);
      const stoppingRun = kind==='cancel' && ['queued','validating','running','canceled'].includes(job.state);
      const requiresConfirmed = kind!=='recover' && !stoppingRun;
      if (requiresConfirmed && unconfirmed.has(jobKey)) throw new Error('上次保存结果待核查，请先检查恢复');
      if (requiresConfirmed && (job.actionItems||[]).some(item=>item.plannedTaskId&&item.status!=='adopted')) {
        throw new Error('行动项保存结果待核查，请先检查恢复');
      }
      return operation(lock.controller, job);
    }).finally(() => active.delete(jobKey));
    return lock.promise;
  }
  function hasPendingOutput(job) {
    return job.plannedDeliverableId && !(job.deliverables||[]).some(item=>item.id===job.plannedDeliverableId);
  }
  async function inspectOutput(job) {
    const output = await repository.inspectDeliverable(job);
    if (output?.id !== job.plannedDeliverableId || output.runId !== job.runId) throw new Error('成果身份未通过核对');
    return [...(job.deliverables||[]),output];
  }
  async function recordCancellation(job) {
    if (job.state === 'canceled') return job;
    const patch = {};
    if (hasPendingOutput(job)) {
      try {
        patch.deliverables = await inspectOutput(job);
      } catch {
        patch.error = '预分配的成果尚未核实，已保留原记录，可继续核查。';
      }
    }
    return move(job,'canceled',patch);
  }
  function cancelPersisted(id) {
    return guarded(id,async (_controller,job) => {
      const canceled = await recordCancellation(job);
      unconfirmed.delete(key(id));
      return canceled;
    },'cancel');
  }
  async function inspectActionItem(job,item){
    if(!plannerRepository?.get||!item.taskSnapshot||!item.plannedTaskId)throw new Error('行动项缺少可核验的计划任务记录');
    const task=await plannerRepository.get(item.plannedTaskId),expected=item.taskSnapshot;
    const fields=['id','kind','title','detail','category','tags','priority','status','startAt','endAt','reminderAt','attachmentPaths','agentJobOrigin'];
    if(fields.some(field=>JSON.stringify(task[field])!==JSON.stringify(expected[field])))throw new Error('行动项任务身份、来源归属或内容不一致，请人工核查');
    return task;
  }
  const runner={
    async delete(id,{expectedRevision}={}) {
      return guarded(id,async(_controller,job)=>{
        if(['queued','validating','running'].includes(job.state))throw new Error('请先取消执行中的委托');
        if(expectedRevision!==undefined&&expectedRevision!==job.revision)throw new Error('委托已更新，请刷新后重新确认删除');
        if(hasPendingOutput(job))throw new Error('还有待核查的成果，请先核查成果后再删除委托');
        return repository.delete(id,{expectedRevision:job.revision});
      },'delete');
    },
    async create(input){
      const job=newAgentJob({type:input.template||'material',title:input.title,goal:input.objective,taskId:input.taskId,sourceIds:input.materialIds,referenceIds:input.referenceIds,material:input.pastedMaterial});
      if(job.taskId&&plannerRepository?.get){const task=await plannerRepository.get(job.taskId);if(task.kind!=='task')throw new Error('委托只能关联当前笔记本的任务');}
      return tracked(job.id,()=>repository.create(job));
    },
    async run(id,answers='',options={}) {
      return guarded(id,async (controller,initialJob)=>{
        const forward=()=>controller.abort();options.signal?.addEventListener('abort',forward,{once:true});if(options.signal?.aborted)controller.abort();
        let job, ownsRun=false;
        try{
          job=initialJob;aborted(controller.signal);
          if(!['draft','needs_input','changes_requested','failed'].includes(job.state))throw new Error('请先处理当前委托状态，不能重复执行');
          if(typeof answers!=='string'||answers.length>20000)throw new Error('补充答复最多20000字');
          if(job.state==='needs_input'&&!answers.trim())throw new Error('请先回答补充问题');
          job=await move(job,'queued',{supplements:answers.trim()?[...job.supplements,answers.trim()]:job.supplements,error:null,questions:[],runId:newNodeID(),plannedDeliverableId:null,plannedDeliverableMarkdown:null});ownsRun=true;aborted(controller.signal);
          job=await move(job,'validating');aborted(controller.signal);
          if(!job.material.trim()&&!job.sourceIds.length&&!job.supplements.length){job=await move(job,'needs_input',{questions:['请粘贴需要处理的材料，或提供可依据的具体内容；当前没有可供整理的材料。']});return job;}
          const materials=[];for(const source of job.sourceIds){aborted(controller.signal);materials.push(await repository.readMaterial(source));}
          const prompt=buildAgentJobPrompt(job,materials);if(prompt.length>240000)throw new Error('显式材料总量超出240000字，请缩小范围');
          job=await move(job,'running');aborted(controller.signal);
          const text=await generateUntilStopped(client,{taskID:job.runId,input:prompt},controller.signal,options.onToken);aborted(controller.signal);
          const result=parseAgentResult(text,[...job.sourceIds,...(job.referenceIds||[])]);
          if(job.type!=='meeting'&&result.actionItems?.length)throw new Error('只有会议委托接受结构化行动项');
          if(result.status==='needs_input')return await move(job,'needs_input',{questions:result.questions});
          for(const source of materials){aborted(controller.signal);const current=await repository.readMaterial(source.id);if(current.content!==source.content)throw new Error('生成期间来源文档已变化，请核对材料后重新执行');}
          // Save the exact output ID before the only document creation step.
          const actionItems=[...(job.actionItems||[]).filter(item=>item.plannedTaskId),...(result.actionItems||[]).map(item=>({...item,itemId:newNodeID(),runId:job.runId,plannedTaskId:null,status:'draft',error:null}))];
          job=await repository.patch(id,{plannedDeliverableId:newNodeID(),plannedDeliverableMarkdown:result.markdown,actionItems},{expectedRevision:job.revision});aborted(controller.signal);
          const deliverable=await repository.saveDeliverable(job,result.markdown);
          // Cancellation after document commit retains that document and records it.
          job=await move(job,controller.signal.aborted?'canceled':'awaiting_review',{deliverables:[...job.deliverables,deliverable],error:null});
          return job;
        }catch(error){
          if(error.commitState){unconfirmed.add(key(id));throw error;}
          if(ownsRun&&['queued','validating','running'].includes(job.state)){
            try{job=controller.signal.aborted?await recordCancellation(job):await move(job,'failed',{error:error.message});}
            catch(saveError){unconfirmed.add(key(id));throw saveError;}
          }
          throw error;
        }finally{options.signal?.removeEventListener('abort',forward);}
      },'run');
    },
    async accept(id,{completeTask=false}={}){if(typeof completeTask!=='boolean')throw new Error('完成关联任务必须明确选择');return guarded(id,async()=>{
      let job=await repository.get(id);job=await move(job,'accepted',{acceptedAt:new Date().toISOString(),taskCompletionError:null});
      if(completeTask&&job.taskId){try{if(!plannerRepository)throw new Error('任务仓储不可用');await plannerRepository.patchTask(job.taskId,{status:'done'});}catch(error){job=await repository.patch(id,{taskCompletionError:'成果已采纳，但关联任务完成操作未确认：'+error.message},{expectedRevision:job.revision});}}
      return job;
    });},
    async return(id,feedback){return guarded(id,async()=>{if(typeof feedback!=='string'||!feedback.trim()||feedback.length>20000)throw new Error('请填写退回意见（最多20000字）');const job=await repository.get(id);return move(job,'changes_requested',{feedback:[...job.feedback,feedback.trim()]});});},
    async adoptActionItem(id,index){return guarded(id,async()=>{
      let job=await repository.get(id);if(!['awaiting_review','accepted'].includes(job.state))throw new Error('请在待验收或已采纳委托中逐条建立任务');
      if(job.type!=='meeting')throw new Error('只有会议委托支持逐条建立行动项任务');
      if(!Number.isInteger(index)||!job.actionItems?.[index])throw new Error('行动项不存在');
      let item=job.actionItems[index];if(item.status==='adopted')return job;
      if(item.plannedTaskId)throw new Error('该行动项已有计划任务ID，请先核查保存结果，不能重复建立');
      if(!workbenchRepository?.create||!plannerRepository?.get)throw new Error('任务仓储不可用');
      const plannedTaskId=newNodeID();
      const detail=item.detail+'\n\n## 委托来源\n\n'+`<!-- siyuan-workbench-action:v1:${id}:${item.itemId} -->`+'\n\n'+`[原始委托](siyuan://blocks/${id})`+'\n'+[...new Set([...job.sourceIds,...(job.referenceIds||[])])].map(source=>`[来源 ${source}](siyuan://blocks/${source})`).join('\n');
      const taskSnapshot={id:plannedTaskId,kind:'task',title:item.title,detail,category:'会议行动项',tags:['Agent委托'],priority:null,status:'todo',startAt:item.startAt,endAt:item.endAt,reminderAt:null,attachmentPaths:[],agentJobOrigin:{jobId:id,actionItemId:item.itemId}};
      item={...item,plannedTaskId,taskSnapshot,status:'planned',error:null};let items=job.actionItems.map((value,i)=>i===index?item:value);
      job=await repository.patch(id,{actionItems:items},{expectedRevision:job.revision});
      try{
        await workbenchRepository.create(structuredClone(taskSnapshot));await inspectActionItem(job,item);
        items=job.actionItems.map((value,i)=>i===index?{...value,status:'adopted',error:null}:value);
        return await repository.patch(id,{actionItems:items},{expectedRevision:job.revision});
      }catch(error){
        // Even an ordinary transport error can occur after the task was created.
        unconfirmed.add(key(id));error.commitState=error.commitState||error.data?.commitState||'unknown';
        try{await repository.patch(id,{actionItems:job.actionItems.map((value,i)=>i===index?{...value,status:'unknown',error:'任务保存结果待核查：'+error.message}:value)},{expectedRevision:job.revision});}catch{}
        throw error;
      }
    });},
    async cancel(id){
      const lock=active.get(key(id));
      if (!lock) return cancelPersisted(id);
      if (lock.kind==='cancel') return lock.promise;
      if (lock.kind!=='run') throw new Error('正在保存或核查当前操作，请稍后再取消');
      if (!lock.canceling) {
        lock.controller.abort();
        // Let any write already sent finish before reading the durable state.
        lock.canceling=lock.promise.catch(()=>{}).then(()=>cancelPersisted(id));
      }
      return lock.canceling;
    },
    async recover(id){
      return guarded(id,async(_controller,job)=>{
      const pending=(job.actionItems||[]).filter(item=>item.plannedTaskId&&item.status!=='adopted');
      if(pending.length){
        const items=[...job.actionItems];
        for(let i=0;i<items.length;i++)if(items[i].plannedTaskId&&items[i].status!=='adopted'){await inspectActionItem(job,items[i]);items[i]={...items[i],status:'adopted',error:null};}
        job=await repository.patch(id,{actionItems:items},{expectedRevision:job.revision});
      }
      if(job.state==='canceled' && hasPendingOutput(job)){
        const deliverables=await inspectOutput(job);
        job=await repository.patch(id,{deliverables,error:null},{expectedRevision:job.revision});
      }
      if(!['queued','validating','running'].includes(job.state)){unconfirmed.delete(key(id));return job;}
      if(job.plannedDeliverableId){
        // An absent/inaccessible document is inconclusive. Never silently replay it.
        const deliverable=await repository.inspectDeliverable(job);
        const recovered=await move(job,'awaiting_review',{deliverables:job.deliverables.some(item=>item.id===deliverable.id)?job.deliverables:[...job.deliverables,deliverable],error:'已核对中断前成果，等待人工验收'});unconfirmed.delete(key(id));return recovered;
      }
      const recovered=await move(job,'failed',{error:'上次执行已中断，没有预分配的成果写入；可检查输入后手动重新执行'});unconfirmed.delete(key(id));return recovered;
      },'recover');
    },
  };return runner;
}
