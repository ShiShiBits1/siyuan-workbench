import {fetchSyncPost} from 'siyuan';
import {isValidNodeID,stableNodeID} from './node-id.js';
const defaultPost=(path,body)=>fetchSyncPost(path,body,undefined,false);
const fence='```workbench-agent-job\n';
const queues=new Map();
// SiYuan's Markdown round-trip removes repeated empty paragraph separators.
// Preserve fenced content verbatim: code blocks can legitimately contain blanks.
export function normalizeAgentMarkdown(markdown, nativeListSpacing = false){
  const result=[];let fenceChar='',fenceLength=0,blank=false;
  for(let line of markdown.replace(/\r\n?/g,'\n').split('\n')){
    const match=line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if(fenceChar){result.push(line);if(match&&match[1][0]===fenceChar&&match[1].length>=fenceLength&&!match[2].trim()){fenceChar='';fenceLength=0;}blank=false;continue;}
    if(match){fenceChar=match[1][0];fenceLength=match[1].length;result.push(line);blank=false;continue;}
    if (nativeListSpacing && /^[-+*] /.test(line)) {
      // SiYuan inserts a block separator before lists following an ATX heading,
      // and a second space between a leading bold label and its value.
      if (blank && /^#{1,6} /.test(result.at(-2) || '')) result.pop();
      line = line.replace(/^([-+*] \*\*[^*\\`]+\*\*) {2}(?=\S)/u, '$1 ');
    }
    if(!line.trim()){if(!blank)result.push('');blank=true;}else{result.push(line);blank=false;}
  }
  return result.join('\n').trim();
}
export function verifyAgentDocumentContent(actual,expected){return typeof actual==='string'&&normalizeAgentMarkdown(actual).includes(normalizeAgentMarkdown(expected));}
export function verifyAgentKramdown(actual,expected){
  if(typeof actual!=='string')return false;
  let fenceChar='',fenceLength=0;const lines=[];
  for(const line of actual.replace(/\r\n?/g,'\n').split('\n')){
    const match=line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if(fenceChar){lines.push(line);if(match&&match[1][0]===fenceChar&&match[1].length>=fenceLength&&!match[2].trim()){fenceChar='';fenceLength=0;}continue;}
    if(match){fenceChar=match[1][0];fenceLength=match[1].length;lines.push(line);continue;}
    if(/^\s*\{:\s+id="\d{14}-[a-z0-9]{7}"[^\n]*\}\s*$/.test(line))continue;
    lines.push(line.replace(/\{:\s+id="\d{14}-[a-z0-9]{7}"[^}\n]*\}/g,''));
  }
  const markdown = lines.join('\n');
  if (expected.startsWith('<!-- siyuan-workbench-deliverable:')) {
    return normalizeAgentMarkdown(markdown, true) === normalizeAgentMarkdown(expected, true);
  }
  return verifyAgentDocumentContent(markdown,expected);
}
export class AgentJobRepository {
  constructor(notebookId,{post=defaultPost}={}){if(!isValidNodeID(notebookId))throw new Error('笔记本ID无效');this.notebookId=notebookId;this.post=post;}
  async api(path,body){const result=await this.post(path,body);if(!result||result.code!==0){const error=new Error(result?.msg||'思源接口失败：'+path);error.data=result?.data;throw error;}return result.data;}
  marker(kind){return `<!-- siyuan-workbench-agent:v1:${this.notebookId}:${kind} -->`;}
  async folder(kind){
    const root=stableNodeID(`${this.notebookId}:siyuan-workbench:root`),id=stableNodeID(`${this.notebookId}:siyuan-workbench:${kind}`);
    await this.ensureDoc(root,null,'思源工作台',`<!-- siyuan-workbench-folder:v1:${this.notebookId}:root -->`);
    await this.ensureDoc(id,root,kind==='agent-jobs'?'Agent委托':'Agent成果',this.marker(kind));return id;
  }
  async ensureDoc(id,parentID,title,markdown){
    let existing=null;
    try{existing=await this.api('/api/export/exportMdContent',{id});}catch{}
    if(existing?.content){await this.checkPath(id,parentID);if(!existing.content.includes(markdown))throw new Error('委托目录ID被其他文档占用');return;}
    await this.createDocument(id,parentID,title,markdown);await this.checkPath(id,parentID);
  }
  async checkPath(id,parentID){
    const location=await this.api('/api/filetree/getPathByID',{id});
    const parts=location?.path?.split('/').filter(Boolean)||[];
    const root=stableNodeID(`${this.notebookId}:siyuan-workbench:root`);
    const depth=parentID===null?1:parentID===root?2:3;
    if(location?.notebook!==this.notebookId||parts.length!==depth||parts.at(-1)!==id+'.sy'||(parentID!==null&&(parts[0]!==root||parts.at(-2)!==parentID)))throw new Error('委托文档已移动或不属于当前笔记本');
    return location;
  }
  async createDocument(id,parentID,title,markdown){
    try{const result=await this.api('/api/filetree/createDocByParent',{notebook:this.notebookId,parentID,id,title:{format:'plain',text:title},markdown});if(result?.id&&result.id!==id)throw new Error('创建文档ID不匹配');}
    catch(error){error.commitState='unknown';error.documentID=id;throw error;}
    try{if(!await this.verifyDocument(id,markdown))throw new Error('新文档读回不一致');}
    catch(error){error.commitState='committed';error.documentID=id;throw error;}
  }
  async list(){
    const rows=[];for(let offset=0;;offset+=500){const page=await this.api('/api/query/sql',{mode:'readonly',stmt:`SELECT id FROM blocks WHERE type='d' AND box='${this.notebookId}' AND hpath LIKE '/思源工作台/Agent委托/%' AND hpath NOT LIKE '/思源工作台/Agent委托/%/%' ORDER BY updated DESC,id ASC LIMIT 500 OFFSET ${offset}`});if(!Array.isArray(page))throw new Error('委托列表无效');rows.push(...page);if(page.length<500)break;}
    const jobs=new Array(rows.length);let cursor=0;await Promise.all(Array.from({length:Math.min(4,rows.length)},async()=>{while(cursor<rows.length){const i=cursor++;jobs[i]=await this.get(rows[i].id);}}));return jobs;
  }
  async read(id){
    if(!isValidNodeID(id))throw new Error('委托ID无效');
    const parent=stableNodeID(`${this.notebookId}:siyuan-workbench:agent-jobs`);await this.checkPath(id,parent);
    const exported=await this.api('/api/export/exportMdContent',{id:parent});if(!exported?.content?.includes(this.marker('agent-jobs')))throw new Error('委托目录标记不匹配');
    const children=await this.api('/api/block/getChildBlocks',{id});const matches=[];
    for(const child of children||[]){if(!['c','code','NodeCodeBlock'].includes(child.type))continue;const data=await this.api('/api/block/getBlockKramdown',{id:child.id});const md=data?.kramdown||'';const start=md.indexOf(fence);if(start<0)continue;const end=md.indexOf('\n```',start+fence.length);if(end<0)throw new Error('委托元数据损坏');const job=JSON.parse(md.slice(start+fence.length,end));if(job.id!==id||job.notebookId!==this.notebookId)throw new Error('委托身份不匹配');const info=await this.api('/api/block/getBlockInfo',{id:child.id});if(info?.rootID!==id||info.box!==this.notebookId)throw new Error('委托记录块已移动');matches.push({job,blockId:child.id,markdown:md,start:start+fence.length,end});}
    if(matches.length!==1)throw new Error('委托元数据缺失或重复');return matches[0];
  }
  async get(id){return (await this.read(id)).job;}
  async delete(id,{expectedRevision}={}) {
    const key=this.notebookId+':'+id;
    const operation=(queues.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{
      const before=await this.read(id);
      if(expectedRevision!==before.job.revision)throw new Error('委托已更新，请刷新后重新确认删除');
      if(['queued','validating','running'].includes(before.job.state))throw new Error('请先取消执行中的委托');
      const location=await this.checkPath(id,stableNodeID(this.notebookId+':siyuan-workbench:agent-jobs'));
      const children=await this.api('/api/filetree/listDocsByPath',{notebook:this.notebookId,path:location.path,showHidden:true,maxListCount:2});
      if(children?.box!==this.notebookId||children.path!==location.path||!Array.isArray(children.files))throw new Error('无法确认委托的子文档范围');
      if(children.files.length)throw new Error('委托下还有子文档，请先在思源文档树整理后再删除');
      const raw=await this.api('/api/block/getBlockKramdown',{id});
      const fresh=await this.read(id),current=await this.api('/api/block/getBlockKramdown',{id});
      await this.checkPath(id,stableNodeID(this.notebookId+':siyuan-workbench:agent-jobs'));
      if(raw?.id!==id||typeof raw.kramdown!=='string'||current?.id!==id||current.kramdown!==raw.kramdown||fresh.markdown!==before.markdown)throw new Error('委托内容已变化，请刷新后重新确认删除');
      const freshChildren=await this.api('/api/filetree/listDocsByPath',{notebook:this.notebookId,path:location.path,showHidden:true,maxListCount:2});
      if(freshChildren?.box!==this.notebookId||freshChildren.path!==location.path||!Array.isArray(freshChildren.files)||freshChildren.files.length)throw new Error('委托子文档已变化，请重新核查');
      try{await this.api('/api/filetree/removeDocByID',{id});}
      catch(error){error.commitState='unknown';error.documentID=id;throw error;}
      try{
        await this.api('/api/sqlite/flushTransaction',{});
        const rows=await this.api('/api/query/sql',{mode:'readonly',stmt:`SELECT id FROM blocks WHERE id='${id}' LIMIT 1`});
        if(!Array.isArray(rows)||rows.length)throw new Error('文档删除状态尚未确认，请刷新核查');
      }catch(error){error.commitState='committed';error.documentID=id;throw error;}
      return {id,deleted:true};
    });
    queues.set(key,operation);
    try{return await operation;}finally{if(queues.get(key)===operation)queues.delete(key);}
  }
  async create(job){const parent=await this.folder('agent-jobs');const stored={...job,notebookId:this.notebookId};await this.createDocument(job.id,parent,job.title,'# Agent委托\n\n委托进度与成果可在工作台查看。此记录可保留原生补充正文。\n\n'+fence+JSON.stringify(stored,null,2)+'\n```');return this.get(job.id);}
  async patch(id,patch,{expectedRevision}={}){
    const key=this.notebookId+':'+id;const previous=queues.get(key)||Promise.resolve();const operation=previous.catch(()=>{}).then(async()=>{
      const before=await this.read(id);if(expectedRevision!==undefined&&before.job.revision!==expectedRevision)throw new Error('委托已更新，请刷新后重试');
      const next={...before.job,...patch,id,notebookId:this.notebookId,revision:before.job.revision+1,updatedAt:new Date().toISOString()};
      const fresh=await this.read(id);if(fresh.blockId!==before.blockId||fresh.markdown!==before.markdown)throw new Error('委托在保存前已被修改');
      const markdown=before.markdown.slice(0,before.start)+JSON.stringify(next,null,2)+before.markdown.slice(before.end);
      try{await this.api('/api/block/updateBlock',{id:before.blockId,dataType:'markdown',data:markdown});}catch(error){error.commitState='unknown';error.documentID=id;throw error;}
      try{const verified=await this.get(id);if(JSON.stringify(verified)!==JSON.stringify(next))throw new Error('委托写后校验失败');return verified;}catch(error){error.commitState='committed';error.documentID=id;throw error;}
    });queues.set(key,operation);try{return await operation;}finally{if(queues.get(key)===operation)queues.delete(key);}
  }
  async readMaterial(id){
    if(!isValidNodeID(id))throw new Error('材料ID无效');
    const location=await this.api('/api/filetree/getPathByID',{id});
    if(location?.notebook!==this.notebookId||!location.path?.endsWith('/'+id+'.sy'))throw new Error('材料须为当前笔记本的普通文档');
    // Export expands block references into documents the user never selected.
    // Raw root Kramdown reads exactly this document without following references.
    const data=await this.api('/api/block/getBlockKramdown',{id});
    if(data?.id!==id||typeof data.kramdown!=='string'||data.kramdown.length>100000)throw new Error('材料身份不匹配、无法读取或超过100000字');
    const again=await this.api('/api/filetree/getPathByID',{id});
    if(JSON.stringify(again)!==JSON.stringify(location))throw new Error('材料位置已变化');
    return {id,content:data.kramdown};
  }
  async saveDeliverable(job,markdown){
    if(!isValidNodeID(job.plannedDeliverableId))throw new Error('成果ID尚未持久保存');
    const parent=await this.folder('agent-deliverables'),id=job.plannedDeliverableId;
    const content=this.deliverableContent(job,markdown);
    await this.createDocument(id,parent,job.title+' · 成果草稿',content);return {id,runId:job.runId,createdAt:new Date().toISOString()};
  }
  deliverableContent(job,markdown){return `<!-- siyuan-workbench-deliverable:v1:${job.id}:${job.runId} -->`+'\n\n'+markdown+'\n\n## 来源\n\n'+[...new Set([...job.sourceIds,...(job.referenceIds||[])])].map(source=>`- [来源 ${source}](siyuan://blocks/${source})`).join('\n')+'\n\n粘贴材料与补充答复保存在委托记录中。内容为待用户核验的草稿。';}
  async verifyDocument(id,expected){
    if(expected.startsWith('<!-- siyuan-workbench-deliverable:')){
      const raw=await this.api('/api/block/getBlockKramdown',{id});return raw?.id===id&&verifyAgentKramdown(raw.kramdown,expected);
    }
    const exported=await this.api('/api/export/exportMdContent',{id});if(verifyAgentDocumentContent(exported?.content,expected))return true;
    // Native export expands siyuan links into footnotes, losing source IDs. Raw
    // Kramdown preserves the exact links; remove only native IAL outside fences.
    const raw=await this.api('/api/block/getBlockKramdown',{id});return raw?.id===id&&verifyAgentKramdown(raw.kramdown,expected);
  }
  async inspectDeliverable(job){if(!job.plannedDeliverableId)return null;const id=job.plannedDeliverableId,parent=stableNodeID(`${this.notebookId}:siyuan-workbench:agent-deliverables`);await this.checkPath(id,parent);if(typeof job.plannedDeliverableMarkdown!=='string'||!await this.verifyDocument(id,this.deliverableContent(job,job.plannedDeliverableMarkdown)))throw new Error('成果正文或标记未通过核对，请手工核查');return {id,runId:job.runId,createdAt:new Date().toISOString()};}
}
