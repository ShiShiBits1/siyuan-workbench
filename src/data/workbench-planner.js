import {fetchSyncPost} from 'siyuan';
import {assertWorkbenchLocation,moveRecordToCategory} from './category-location.js';
import {readWorkbenchRecords,readWorkbenchRecord} from './read-record-list.js';
import {isValidNodeID,stableNodeID} from './node-id.js';
import {validateRecord,TASK_STATUSES,TASK_PRIORITIES,validateQuadrantOverride} from '../domain/workbench.js';
import {parseWorkbenchRecordMarkdown} from '../domain/workbench-markdown.js';
import {withTaskHistory} from '../domain/task-history.js';
import {syncTaskAttachmentRefs} from './task-attachment-refs.js';
import {normalizeChecklist} from '../domain/task-checklist.js';

const defaultPost=(path,body)=>fetchSyncPost(path,body,undefined,false);
const folderFor=kind=>kind==='task'?'任务':'日程';
const markerFor=kind=>kind==='task'?'tasks':'events';
const iso=value=>value===null || (typeof value==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)));

/** Narrow record updates touch only the existing machine-record code block. */
export class WorkbenchPlannerRepository {
  constructor(notebookId,{post=defaultPost}={}) {
    if(!isValidNodeID(notebookId)) throw new Error('请选择有效的笔记本');
    this.notebookId=notebookId;this.post=post;this.pending=Promise.resolve();
  }
  listTasks(){return this.#list('task');}
  listEvents(){return this.#list('event');}
  async #list(kind) {return readWorkbenchRecords({notebookId:this.notebookId,kind,post:this.post});}
  async get(id){return (await this.#read(id)).record;}
  async deleteTask(id,options={}){return this.#deleteRecord(id,'task',options);}
  async deleteEvent(id,options={}){return this.#deleteRecord(id,'event',options);}
  async #deleteRecord(id,kind,{expectedUpdatedAt}={}){
    const label=kind==='event'?'日程':'任务';
    return this.#queue(async()=>{
      try{
      const before=await this.#read(id);
      if(before.record.kind!==kind)throw new Error(kind==='event'?'只有日程可以从日历删除':'只有任务可以从任务中心删除');
      if(expectedUpdatedAt!==undefined&&before.record.updatedAt!==expectedUpdatedAt)throw new Error(label+'在确认期间已更新，请刷新后重新确认删除');
      await readWorkbenchRecord({notebookId:this.notebookId,id,post:this.post});
      const raw=await this.#deleteDocumentSnapshot(id,kind);
      const fresh=await this.#read(id),current=await this.#deleteDocumentSnapshot(id,kind);
      if(fresh.record.kind!==kind||fresh.blockID!==before.blockID||fresh.kramdown!==before.kramdown||current!==raw)throw new Error(label+'正文或位置已发生变化，请刷新后重新确认删除');
      }catch(error){error.commitState='none';error.documentID=id;error.data={...error.data,commitState:'none',id};throw error;}
      try{await this.#post('/api/filetree/removeDocByID',{id});}
      catch(error){error.commitState=error.data?.commitState==='none'?'none':'unknown';error.documentID=id;error.data={...error.data,commitState:error.commitState,id};error.message=label+'删除结果未确认，请先核查原文档，勿重复删除：'+error.message;throw error;}
      try{
        // Public v3.8.9 docs/API.md#flush-transaction defines the SQL visibility
        // barrier. Flush once after the write; never repeat the deletion.
        await this.#post('/api/sqlite/flushTransaction',{});
        const response=await this.#post('/api/query/sql',{mode:'readonly',stmt:`SELECT id FROM blocks WHERE id='${id}' LIMIT 1`});
        if(!Array.isArray(response.data))throw new Error('删除核查响应无效');
        if(response.data.length)throw new Error('删除后的文档索引尚未确认消失');
      }catch(error){error.commitState='committed';error.documentID=id;error.data={...error.data,commitState:'committed',id};error.message=label+'删除已提交，但核查失败，请刷新核对：'+error.message;throw error;}
      return {id,deleted:true,commitState:'committed'};
    });
  }
  async #deleteDocumentSnapshot(id,kind){
    const label=kind==='event'?'日程':'任务';
    const location=await this.#location(id,kind);
    const children=(await this.#post('/api/filetree/listDocsByPath',{notebook:this.notebookId,path:location.path,showHidden:true,maxListCount:2})).data;
    if(children?.box!==this.notebookId||children.path!==location.path||!Array.isArray(children.files))throw new Error('无法确认'+label+'的子文档范围，未删除');
    let ownedBody=null;
    if(children.files.length){
      const bodyId=stableNodeID(id+':workbench-task-body');
      if(kind!=='task'||children.files.length!==1||children.files[0]?.id!==bodyId)throw new Error(label+'下还有子文档，请先在思源原生文档树整理后再删除');
      const bodyPath=location.path.replace(/\.sy$/,'')+'/'+bodyId+'.sy';
      const [bodyLocation,attrs,bodyRaw,descendants]=await Promise.all([
        this.#post('/api/filetree/getPathByID',{id:bodyId}),
        this.#post('/api/attr/getBlockAttrs',{id:bodyId}),
        this.#post('/api/block/getBlockKramdown',{id:bodyId}),
        this.#post('/api/filetree/listDocsByPath',{notebook:this.notebookId,path:bodyPath,showHidden:true,maxListCount:1}),
      ]);
      if(bodyLocation.data?.notebook!==this.notebookId||bodyLocation.data.path!==bodyPath||
        attrs.data?.['custom-workbench-task-body']!==id||bodyRaw.data?.id!==bodyId||typeof bodyRaw.data.kramdown!=='string'||
        descendants.data?.box!==this.notebookId||descendants.data.path!==bodyPath||
        !Array.isArray(descendants.data.files)||descendants.data.files.length){
        throw new Error('任务正文的归属或子文档范围无法确认，请先在思源原生文档树核查');
      }
      ownedBody={id:bodyId,location:bodyLocation.data,attrs:attrs.data,body:bodyRaw.data.kramdown};
    }
    const raw=(await this.#post('/api/block/getBlockKramdown',{id})).data;
    if(raw?.id!==id||typeof raw.kramdown!=='string')throw new Error('无法核对'+label+'完整正文，未删除');
    return JSON.stringify({location,body:raw.kramdown,ownedBody});
  }
  async patchTask(id,patch,{expectedUpdatedAt}={}){this.#validatePatch(patch,false);return this.#queue(async()=>{try{return await this.#patch(id,patch,'task',expectedUpdatedAt);}catch(error){if(!error.commitState){error.commitState='none';error.data={...error.data,commitState:'none',id};}throw error;}});}
  async patchEvent(id,patch,{expectedUpdatedAt}={}){
    try{
      const fields=['title','category','startAt','endAt','reminderAt','detail'];
      if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length||Object.keys(patch).some(key=>!fields.includes(key)))throw new Error('日程修改字段无效');
      this.#validateBusinessFields(patch);
    }catch(error){error.commitState='none';error.documentID=id;error.data={...error.data,commitState:'none',id};throw error;}
    return this.#queue(async()=>{
      try{return await this.#patch(id,patch,'event',expectedUpdatedAt);}
      catch(error){if(!error.commitState){error.commitState='none';error.documentID=id;error.data={...error.data,commitState:'none',id};}throw error;}
    });
  }
  async patchReminder(id,patch){this.#validatePatch(patch,true);return this.#queue(()=>this.#patch(id,patch,null));}
  async patchRecord(id,patch,{expectedUpdatedAt}={}){
    const fields=['title','category','detail','startAt','endAt','reminderAt','tags','priority','status','attachmentPaths','checklist','quadrantOverride'];
    if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length||Object.keys(patch).some(key=>!fields.includes(key)))throw new Error('记录修改字段无效');
    this.#validateBusinessFields(patch);
    return this.#queue(()=>this.#patch(id,patch,null,expectedUpdatedAt));
  }
  #validateBusinessFields(patch){
    if('quadrantOverride'in patch)validateQuadrantOverride(patch.quadrantOverride);
    if('checklist'in patch)normalizeChecklist(patch.checklist);
    for(const key of ['title','category','detail'])if(key in patch && !(key==='category'&&patch[key]===null) && typeof patch[key]!=='string')throw new Error('记录文本字段无效');
    if('title'in patch&&(!patch.title.trim()||patch.title.length>200))throw new Error('标题不能为空或超过200字符');
    if('detail'in patch&&patch.detail.length>100000)throw new Error('详细内容过长');
    for(const key of ['tags','attachmentPaths'])if(key in patch&&(!Array.isArray(patch[key])||patch[key].length>100||patch[key].some(value=>typeof value!=='string')))throw new Error('标签或附件格式无效');
    if('status'in patch&&!TASK_STATUSES.includes(patch.status))throw new Error('任务状态无效');
    if('priority'in patch&&patch.priority!==null&&!TASK_PRIORITIES.includes(patch.priority))throw new Error('任务优先级无效');
    for(const key of ['startAt','endAt','reminderAt'])if(key in patch&&!iso(patch[key]))throw new Error('时间必须为带时区 ISO 时间或空值');
  }
  #queue(operation){const result=this.pending.then(operation);this.pending=result.catch(()=>{});return result;}
  #validatePatch(patch,reminder){
    const fields=reminder?['reminderAt']:['status','priority','startAt','endAt','category','checklist','quadrantOverride'];
    if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length||Object.keys(patch).some(key=>!fields.includes(key)))throw new Error('任务修改字段无效');
    if('status'in patch&&!TASK_STATUSES.includes(patch.status))throw new Error('任务状态无效');
    if('priority'in patch&&patch.priority!==null&&!TASK_PRIORITIES.includes(patch.priority))throw new Error('任务优先级无效');
    if('category'in patch&&typeof patch.category!=='string')throw new Error('分类格式无效');
    if('checklist'in patch)normalizeChecklist(patch.checklist);
    if('quadrantOverride'in patch)validateQuadrantOverride(patch.quadrantOverride);
    for(const key of ['startAt','endAt','reminderAt'])if(key in patch&&!iso(patch[key]))throw new Error('时间必须为带时区 ISO 时间或空值');
  }
  async #patch(id,patch,kind,expectedUpdatedAt){
    const before=await this.#read(id);if(kind&&before.record.kind!==kind)throw new Error(kind==='event'?'只有日程支持此操作':'只有任务支持此操作');
    if(expectedUpdatedAt!==undefined&&before.record.updatedAt!==expectedUpdatedAt)throw new Error('记录在编辑期间已更新，请刷新后重新保存');
    if(before.record.kind==='event'&&['tags','priority','status','attachmentPaths','checklist','quadrantOverride'].some(key=>key in patch))throw new Error('日程不接受任务专属字段');
    if('checklist'in patch){
      const previous=new Map((before.record.checklist||[]).map(item=>[item.id,item]));
      patch={...patch,checklist:patch.checklist.map(item=>({...previous.get(item.id),...item}))};
    }
    const oldTime=Date.parse(before.record.updatedAt);
    const validated=validateRecord({...before.record,...patch,updatedAt:new Date(Math.max(Date.now(),Number.isFinite(oldTime)?oldTime+1:0)).toISOString()});
    const next=withTaskHistory(before.record,{...before.record,...validated},validated.updatedAt);
    // Re-read after all preparatory requests: do not overwrite concurrent edits or a moved block.
    const fresh=await this.#read(id);
    if(fresh.blockID!==before.blockID||fresh.kramdown!==before.kramdown)throw new Error('记录已发生变化，请刷新后重试');
    await this.#location(id,next.kind);
    const normalizedPatch=Object.fromEntries(Object.keys(patch).map(key=>[key,next[key]]));
    const payload={...before.payload,...normalizedPatch,updatedAt:next.updatedAt};
    if(next.kind==='task'){payload.historyTrackingSince=next.historyTrackingSince;payload.workbenchHistory=next.workbenchHistory;if('completedAt'in next)payload.completedAt=next.completedAt;}
    const markdown=before.kramdown.slice(0,before.jsonStart)+JSON.stringify(payload,null,2)+before.kramdown.slice(before.jsonEnd);
    try {await this.#post('/api/block/updateBlock',{id:before.blockID,dataType:'markdown',data:markdown});}
    catch(error){error.commitState='unknown';error.documentID=id;error.data={...error.data,commitState:'unknown',id};error.message='记录更新结果尚未确认，请先刷新核查：'+error.message;throw error;}
    try{
      if('category'in patch&&next.category!==before.record.category){
        try{await moveRecordToCategory({notebookId:this.notebookId,id,kind:next.kind,category:next.category,post:this.post});}
        catch(error){error.stage='category-move';error.categoryPending=true;error.data={...error.data,categoryPending:true};error.message='分类字段已保存，但分类归档未确认，请核查实际文档目录：'+error.message;throw error;}
      }
      if('status'in patch)await this.#post('/api/attr/setBlockAttrs',{id,attrs:{'custom-workbench-status':next.status}});
      if(next.kind==='task'&&'attachmentPaths'in patch)await syncTaskAttachmentRefs({post:(path,body)=>this.#post(path,body),id,attachmentPaths:next.attachmentPaths});
      if('title'in patch&&next.title!==before.record.title){
        await this.#location(id,next.kind);
        const location=(await this.#post('/api/filetree/getPathByID',{id})).data;
        await this.#post('/api/filetree/renameDoc',{notebook:this.notebookId,path:location.path,title:next.title});
      }
      const verified=await this.#read(id);
      if(JSON.stringify(verified.payload)!==JSON.stringify(payload))throw new Error('记录写入后校验不一致');
      return {...verified.payload,...verified.record};
    }catch(error){error.commitState='committed';error.documentID=id;error.data={...error.data,commitState:'committed',id};error.message=(before.record.kind==='event'?'日程':'任务')+'记录已保存，但属性、标题同步或读回失败，请刷新核查：'+error.message;throw error;}
  }
  async #read(id){
    if(!isValidNodeID(id))throw new Error('工作台记录 ID 无效');
    const attrs=(await this.#post('/api/attr/getBlockAttrs',{id})).data;
    const kind=attrs?.['custom-workbench-type'];
    if(!['task','event'].includes(kind)||attrs['custom-workbench-id']!==id)throw new Error('文档不是当前工作台任务或日程');
    await this.#location(id,kind);
    const children=(await this.#post('/api/block/getChildBlocks',{id})).data;
    if(!Array.isArray(children))throw new Error('无法读取工作台记录子块');
    const matches=[];
    for(const child of children){
      if(!['c','code','NodeCodeBlock'].includes(child?.type))continue;
      if(!isValidNodeID(child.id))throw new Error('记录块 ID 无效');
      const data=(await this.#post('/api/block/getBlockKramdown',{id:child.id})).data;
      if(data?.id!==child.id||typeof data.kramdown!=='string')throw new Error('无法读取记录块');
      if(!data.kramdown.includes('```workbench-record\n'))continue;
      const record=parseWorkbenchRecordMarkdown(data.kramdown);
      if(record?.id!==id)continue;
      if(record.kind!==kind||(record.docId&&record.docId!==id))throw new Error('记录类型或文档身份不匹配');
      // Confirm the candidate is still a child of this document, including after a move.
      const info=(await this.#post('/api/block/getBlockInfo',{id:child.id})).data;
      if(info?.rootID!==id||info?.box!==this.notebookId)throw new Error('记录块已移出当前文档');
      const jsonStart=data.kramdown.lastIndexOf('```workbench-record\n')+'```workbench-record\n'.length;
      const jsonEnd=data.kramdown.indexOf('\n```',jsonStart);
      const payload=JSON.parse(data.kramdown.slice(jsonStart,jsonEnd));
      matches.push({record:{...payload,...record},payload,jsonStart,jsonEnd,blockID:child.id,kramdown:data.kramdown});
    }
    if(matches.length!==1)throw new Error('记录块缺失或存在多个匹配标记，请在思源中核查');
    return matches[0];
  }
  async #location(id,kind){
    return assertWorkbenchLocation({notebookId:this.notebookId,id,kind,post:this.post});
  }

  async #post(path,body){const res=await this.post(path,body);if(!res||res.code!==0){const error=new Error(res?.msg||`思源接口调用失败：${path}`);error.data=res?.data;throw error;}return res;}
}
