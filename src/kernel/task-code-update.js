import {isValidNodeID} from '../data/node-id.js';
import {validateRecord} from '../domain/workbench.js';
import {parseWorkbenchRecordMarkdown,WORKBENCH_RECORD_MARKER} from '../domain/workbench-markdown.js';
import {withTaskHistory} from '../domain/task-history.js';

/** Kernel-safe targeted completion; no frontend SDK and no whole-document rewrite. */
export async function completeTaskCode({post,id,notebookId,assertLocation,now=()=>new Date()}) {
  if(!isValidNodeID(id)||!isValidNodeID(notebookId)||typeof assertLocation!=='function')throw new Error('完成任务的目标参数无效');
  async function api(path,body){
    const response=await post(path,body);
    if(!response||response.code!==0)throw new Error(response?.msg||`思源接口失败：${path}`);
    return response.data;
  }
  async function checkBlock(blockID){
    const info=await api('/api/block/getBlockInfo',{id:blockID});
    if(info?.rootID!==id||info?.box!==notebookId)throw new Error('任务记录块已移出当前文档，未覆盖内容');
  }
  async function snapshot(){
    await assertLocation();
    const children=await api('/api/block/getChildBlocks',{id});
    if(!Array.isArray(children))throw new Error('无法读取任务子块');
    const matches=[];
    for(const child of children){
      if(!['c','code','NodeCodeBlock'].includes(child?.type))continue;
      if(!isValidNodeID(child.id))throw new Error('任务记录块 ID 无效');
      const data=await api('/api/block/getBlockKramdown',{id:child.id});
      if(data?.id!==child.id||typeof data.kramdown!=='string')throw new Error('无法读取任务记录块');
      if(!data.kramdown.includes(WORKBENCH_RECORD_MARKER))continue;
      const record=parseWorkbenchRecordMarkdown(data.kramdown);
      if(record?.id!==id)continue;
      if(record.kind!=='task'||(record.docId&&record.docId!==id))throw new Error('任务文档与记录身份不一致');
      await checkBlock(child.id);
      const jsonStart=data.kramdown.lastIndexOf(WORKBENCH_RECORD_MARKER)+WORKBENCH_RECORD_MARKER.length;
      const jsonEnd=data.kramdown.indexOf('\n```',jsonStart);
      const payload=JSON.parse(data.kramdown.slice(jsonStart,jsonEnd));
      matches.push({record,payload,kramdown:data.kramdown,blockID:child.id,jsonStart,jsonEnd});
    }
    if(matches.length!==1)throw new Error('任务记录块缺失、身份不匹配或存在多个标记，请核查');
    return matches[0];
  }
  const before=await snapshot();
  // Identity and scope checks precede this idempotent branch as well.
  if(before.record.status==='done'){await assertLocation();return before.record;}
  const updatedAt=now().toISOString();
  const payload=withTaskHistory(before.payload,{...before.payload,status:'done',updatedAt},updatedAt);
  validateRecord(payload);
  const fresh=await snapshot();
  if(fresh.blockID!==before.blockID||fresh.kramdown!==before.kramdown)throw new Error('任务在完成前已发生变化，请刷新后重试');
  await assertLocation();await checkBlock(before.blockID);
  const markdown=before.kramdown.slice(0,before.jsonStart)+JSON.stringify(payload,null,2)+before.kramdown.slice(before.jsonEnd);
  try{await api('/api/block/updateBlock',{id:before.blockID,dataType:'markdown',data:markdown});}
  catch(failure){const error=failure instanceof Error?failure:new Error(String(failure));error.commitState='unknown';error.documentID=id;throw error;}
  try{
    await api('/api/attr/setBlockAttrs',{id,attrs:{'custom-workbench-status':'done'}});
    const verified=await snapshot();
    if(verified.record.status!=='done'||JSON.stringify(verified.payload)!==JSON.stringify(payload))throw new Error('完成任务后读回与预期不一致');
    return verified.record;
  }catch(failure){
    const error=failure instanceof Error?failure:new Error(String(failure));
    error.commitState='committed';error.documentID=id;
    error.message='任务记录已提交，但属性同步或读回校验失败，请刷新核查：'+error.message;
    throw error;
  }
}
