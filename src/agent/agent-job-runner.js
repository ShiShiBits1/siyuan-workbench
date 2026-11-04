import {newAgentJob,transitionAgentJob,buildAgentJobPrompt,parseAgentResult} from '../domain/agent-job.js';
import {newNodeID} from '../data/node-id.js';
const active=new Map(),unconfirmed=new Set();
const aborted=signal=>{if(signal?.aborted)throw new DOMException('已停止委托，已保存的成果仍保留','AbortError');};
export function createAgentJobRunner({repository,client,plannerRepository,workbenchRepository}={}) {
  const key=id=>repository.notebookId+':'+id;
  async function tracked(id,operation){try{return await operation();}catch(error){if(error.commitState)unconfirmed.add(key(id));throw error;}}
  async function move(job,state,patch={}){const next=transitionAgentJob(job,state,patch);return repository.patch(job.id,next,{expectedRevision:job.revision});}
  async function guarded(id,operation){if(active.has(key(id)))throw new Error('该委托正在执行，请等待或停止');if(unconfirmed.has(key(id)))throw new Error('上次保存结果待核查，请先检查恢复');const controller=new AbortController();active.set(key(id),controller);try{return await tracked(id,async()=>{const job=await repository.get(id);if((job.actionItems||[]).some(item=>item.plannedTaskId&&item.status!=='adopted'))throw new Error('行动项保存结果待核查，请先检查恢复');return operation(controller);});}finally{active.delete(key(id));}}
  async function inspectActionItem(job,item){
    if(!plannerRepository?.get||!item.taskSnapshot||!item.plannedTaskId)throw new Error('行动项缺少可核验的计划任务记录');
    const task=await plannerRepository.get(item.plannedTaskId),expected=item.taskSnapshot;
    const fields=['id','kind','title','detail','category','tags','priority','status','startAt','endAt','reminderAt','attachmentPaths','agentJobOrigin'];
    if(fields.some(field=>JSON.stringify(task[field])!==JSON.stringify(expected[field])))throw new Error('行动项任务身份、来源归属或内容不一致，请人工核查');
    return task;
  }
  const runner={
    async create(input){
      const job=newAgentJob({type:input.template||'material',title:input.title,goal:input.objective,taskId:input.taskId,sourceIds:input.materialIds,referenceIds:input.referenceIds,material:input.pastedMaterial});
      if(job.taskId&&plannerRepository?.get){const task=await plannerRepository.get(job.taskId);if(task.kind!=='task')throw new Error('委托只能关联当前笔记本的任务');}
      return tracked(job.id,()=>repository.create(job));
    },
    async run(id,answers='',options={}) {
      return guarded(id,async controller=>{
        const forward=()=>controller.abort();options.signal?.addEventListener('abort',forward,{once:true});if(options.signal?.aborted)controller.abort();
        let job;
        try{
          job=await repository.get(id);aborted(controller.signal);
          if(!['draft','needs_input','changes_requested','failed'].includes(job.state))throw new Error('请先处理当前委托状态，不能重复执行');
          if(typeof answers!=='string'||answers.length>20000)throw new Error('补充答复最多20000字');
          if(job.state==='needs_input'&&!answers.trim())throw new Error('请先回答补充问题');
          job=await move(job,'queued',{supplements:answers.trim()?[...job.supplements,answers.trim()]:job.supplements,error:null,questions:[],runId:newNodeID(),plannedDeliverableId:null,plannedDeliverableMarkdown:null});aborted(controller.signal);
          job=await move(job,'validating');aborted(controller.signal);
          if(!job.material.trim()&&!job.sourceIds.length&&!job.supplements.length){job=await move(job,'needs_input',{questions:['请粘贴需要处理的材料，或提供可依据的具体内容；当前没有可供整理的材料。']});return job;}
          const materials=[];for(const source of job.sourceIds){aborted(controller.signal);materials.push(await repository.readMaterial(source));}
          const prompt=buildAgentJobPrompt(job,materials);if(prompt.length>240000)throw new Error('显式材料总量超出240000字，请缩小范围');
          job=await move(job,'running');aborted(controller.signal);
          const text=await client.generate({taskID:job.runId,input:prompt},{signal:controller.signal,onToken:options.onToken});aborted(controller.signal);
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
          if(job&&['queued','validating','running'].includes(job.state)){
            try{job=await move(job,controller.signal.aborted?'canceled':'failed',{error:controller.signal.aborted?'已停止生成；保存过的文档仍保留':error.message});}
            catch(saveError){unconfirmed.add(key(id));throw saveError;}
          }
          throw error;
        }finally{options.signal?.removeEventListener('abort',forward);}
      });
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
    async cancel(id){const running=active.get(key(id));if(running){running.abort();return null;}return guarded(id,async()=>{const job=await repository.get(id);return move(job,'canceled');});},
    async recover(id){
      if(active.has(key(id)))throw new Error('委托仍在本窗口执行，请先停止');
      return tracked(id,async()=>{
      let job=await repository.get(id);
      const pending=(job.actionItems||[]).filter(item=>item.plannedTaskId&&item.status!=='adopted');
      if(pending.length){
        const items=[...job.actionItems];
        for(let i=0;i<items.length;i++)if(items[i].plannedTaskId&&items[i].status!=='adopted'){await inspectActionItem(job,items[i]);items[i]={...items[i],status:'adopted',error:null};}
        job=await repository.patch(id,{actionItems:items},{expectedRevision:job.revision});
      }
      if(!['queued','validating','running'].includes(job.state)){unconfirmed.delete(key(id));return job;}
      if(job.plannedDeliverableId){
        // An absent/inaccessible document is inconclusive. Never silently replay it.
        const deliverable=await repository.inspectDeliverable(job);
        const recovered=await move(job,'awaiting_review',{deliverables:job.deliverables.some(item=>item.id===deliverable.id)?job.deliverables:[...job.deliverables,deliverable],error:'已核对中断前成果，等待人工验收'});unconfirmed.delete(key(id));return recovered;
      }
      const recovered=await move(job,'failed',{error:'上次执行已中断，没有预分配的成果写入；可检查输入后手动重新执行'});unconfirmed.delete(key(id));return recovered;
      });
    },
  };return runner;
}
