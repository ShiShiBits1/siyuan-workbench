import {assertWorkbenchLocation,assertCategoryFolder} from './category-location.js';
import {isValidNodeID} from './node-id.js';
import {validateRecord} from '../domain/workbench.js';

function parseRecord(markdown,id,kind){
  if(typeof markdown!=='string')throw new Error('工作台记录正文无效');
  const records=[];let fence=null,lines=[];
  for(const line of markdown.replace(/\r\n?/g,'\n').split('\n')){
    const match=line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if(!fence){if(match){fence={char:match[1][0],length:match[1].length,record:match[2].trim()==='workbench-record'};lines=[];}continue;}
    if(match&&match[1][0]===fence.char&&match[1].length>=fence.length&&!match[2].trim()){
      if(fence.record){let raw;try{raw=JSON.parse(lines.join('\n'));}catch{throw new Error('工作台记录JSON损坏');}records.push(raw);}
      fence=null;lines=[];continue;
    }
    if(fence.record)lines.push(line);
  }
  if(fence?.record)throw new Error('工作台记录缺少闭合标记');
  if(records.length!==1)throw new Error('工作台记录块缺失或存在多个标记');
  const raw=records[0];
  if(!raw||!isValidNodeID(raw.id)||raw.id!==id||(raw.docId!==undefined&&raw.docId!==id)||(kind&&raw.kind!==kind))throw new Error('工作台记录身份或类型不匹配');
  return {...raw,...validateRecord(raw)};
}

/** Read-only listing. Folder identity caches live only for this invocation.
 * Writers continue to perform their independent, stricter pre-commit checks.
 */
export const readWorkbenchRecords=options=>readRecords(options,false);
export const readWorkbenchRecord=async options=>(await readRecords(options,true))[0];
export const readWorkbenchCategories=options=>readRecords(options,false,true);
async function readRecords({notebookId,kind,post,id:singleId,timeoutMs=15000},single,categoriesOnly=false){
  if(!isValidNodeID(notebookId)||(!single&&!['task','event'].includes(kind))||(single&&!isValidNodeID(singleId))||typeof post!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new Error('工作台列表参数无效');
  let stopped=null;
  async function api(path,body){
    if(stopped)throw stopped;let timer;
    try{
      const result=await Promise.race([Promise.resolve().then(()=>post(path,body)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('工作台读取超时，请稍后刷新')),timeoutMs);})]);
      if(!result||result.code!==0){const error=new Error(result?.msg||'工作台读取失败：'+path);error.code=result?.code;error.data=result?.data;throw error;}return result.data;
    }catch(error){stopped=stopped||error;throw stopped;}finally{clearTimeout(timer);}
  }
  let singleRaw;
  if(single){singleRaw=await api('/api/block/getBlockKramdown',{id:singleId});if(singleRaw?.id!==singleId||typeof singleRaw.kramdown!=='string')throw new Error('工作台记录响应身份不匹配');kind=parseRecord(singleRaw.kramdown,singleId).kind;}
  const folderName=kind==='task'?'任务':'日程';
  const ids=[],seen=new Set();
  if(single)ids.push(singleId);
  else for(let offset=0;;offset+=500){
    // Native titles can contain literal slashes in hpath. Only the ID-based
    // storage path can bound candidate depth; fresh folder proofs follow below.
    const rows=await api('/api/query/sql',{mode:'readonly',stmt:`SELECT id FROM blocks WHERE type='d' AND box='${notebookId}' AND hpath LIKE '/思源工作台/${folderName}/%' AND (LENGTH(path)-LENGTH(REPLACE(path,'/',''))) IN (3,4) ORDER BY updated DESC, id ASC LIMIT 500 OFFSET ${offset}`});
    if(!Array.isArray(rows)||rows.length>500)throw new Error('工作台列表响应无效');
    for(const row of rows){if(!isValidNodeID(row?.id)||seen.has(row.id))throw new Error('工作台列表存在无效或重复ID，请刷新');seen.add(row.id);ids.push(row.id);}
    if(rows.length<500)break;
  }
  const folderChecks=new Map();
  const rootReads=new Map(single?[[singleId,Promise.resolve(singleRaw)]]:[]),locationReads=new Map(),parentChecks=new Map();
  const scopedPost=async(path,body)=>({code:0,data:await api(path,body)});
  function readRoot(id){
    if(!rootReads.has(id))rootReads.set(id,(async()=>{
      const raw=await api('/api/block/getBlockKramdown',{id});
      if(raw?.id!==id||typeof raw.kramdown!=='string')throw new Error('工作台记录响应身份不匹配');
      return raw;
    })());
    return rootReads.get(id);
  }
  function readLocation(id){
    if(!locationReads.has(id))locationReads.set(id,api('/api/filetree/getPathByID',{id}));
    return locationReads.get(id);
  }
  function classifyParent(parts){
    const [rootId,parentId,id]=parts,key=parts.slice(0,3).join('/');
    if(!parentChecks.has(key))parentChecks.set(key,(async()=>{
      const raw=await readRoot(id),location=await readLocation(id);
      if(location?.notebook!==notebookId||location.path!==`/${rootId}/${parentId}/${id}.sy`)throw new Error('记录父文档位置不匹配');
      if(raw.kramdown.includes('<!-- siyuan-workbench-category:v1:')){
        await assertCategoryFolder({notebookId,kind,rootId,parentId,id,post:scopedPost,cache:folderChecks});
        return 'category';
      }
      // A valid legacy record can own ordinary native child documents. They
      // share the SQL depth of classified records but are not business records.
      await assertWorkbenchLocation({notebookId,id,kind,location,post:scopedPost,cache:folderChecks});
      parseRecord(raw.kramdown,id,kind);
      return 'legacy-record';
    })());
    return parentChecks.get(key);
  }
  const records=new Array(ids.length),categories=new Set();let cursor=0;
  await Promise.all(Array.from({length:Math.min(4,ids.length)},async()=>{
    while(!stopped&&cursor<ids.length){
      try{
      const index=cursor++,id=ids[index];
      // Raw root Kramdown never expands native block references into other docs.
      const raw=await readRoot(id),location=await readLocation(id);
      const parts=location?.path?.split('/').filter(Boolean)||[];
      if(!single&&parts.length===4){
        if(location?.notebook!==notebookId||parts[3]!==id+'.sy'||!parts.slice(0,-1).every(isValidNodeID))throw new Error('记录不在所选笔记本的工作台目录');
        if(await classifyParent(parts)==='legacy-record')continue;
      }
      if(!single&&raw.kramdown.includes('<!-- siyuan-workbench-category:v1:')&&!raw.kramdown.includes('```workbench-record')){
        if(parts.length!==3||parts[2]!==id+'.sy')throw new Error('分类目录位置无效');
        const category=await assertCategoryFolder({notebookId,kind,rootId:parts[0],parentId:parts[1],id,post:scopedPost,cache:folderChecks});
        if(categoriesOnly)categories.add(category);
        continue;
      }
      await assertWorkbenchLocation({notebookId,id,kind,location,post:scopedPost,cache:folderChecks});
      const record=parseRecord(raw.kramdown,id,kind);
      if(categoriesOnly){const category=record.category.trim();if(category)categories.add(category);}
      else records[index]=record;
      }catch(error){stopped=stopped||error;throw stopped;}
    }
  }));
  return categoriesOnly?[...categories].sort((a,b)=>a.localeCompare(b,'zh-CN')):records.filter(Boolean);
}
