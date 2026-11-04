import {isValidNodeID,stableNodeID} from './node-id.js';
export const normalizeCategory=value=>String(value??'').trim()||'未分类';
const folderFor=kind=>kind==='task'?'任务':'日程';
const markerFor=kind=>kind==='task'?'tasks':'events';
const seed=(book,kind,category)=>`${book}:siyuan-workbench:category:${kind}:${encodeURIComponent(normalizeCategory(category))}`;
export const categoryFolderID=(book,kind,category)=>stableNodeID(seed(book,kind,category));
export function categoryFolderTitle(category){const label=normalizeCategory(category),safe=Array.from(label.replace(/[\\/:*?"<>|\r\n\t]/g,'_')).slice(0,60).join('');return safe===label&&label!=='.'&&label!=='..'?label:safe+' · '+stableNodeID('category-title:'+encodeURIComponent(label)).slice(-7);}
export const categoryFolderMarker=(book,kind,category)=>`<!-- siyuan-workbench-category:v1:${book}:${kind}:${encodeURIComponent(normalizeCategory(category))} -->`;
export function categoryFromMarker(markdown,book,kind){
  const matches=[...String(markdown).matchAll(/<!-- siyuan-workbench-category:v1:([^:]+):([^:]+):([^\s]+) -->/g)];
  if(!matches.length)return null;
  if(matches.length!==1||matches[0][1]!==book||matches[0][2]!==kind)throw new Error('分类目录标记不匹配或重复');
  let category;try{category=decodeURIComponent(matches[0][3]);}catch{throw new Error('分类目录编码无效');}
  if(!category||normalizeCategory(category)!==category)throw new Error('分类目录名称无效');return category;
}
export async function categoryPost(post,path,body){const result=await post(path,body);if(!result||result.code!==0){const error=new Error(result?.msg||'分类目录接口失败：'+path);error.code=result?.code;error.data=result?.data;throw error;}return result.data;}
export async function assertKindFolder({notebookId,kind,rootId,parentId,post,cache=new Map()}){
  if(!isValidNodeID(notebookId)||!['task','event'].includes(kind)||![rootId,parentId].every(isValidNodeID))throw new Error('工作台目录身份无效');
  const key=`kind:${notebookId}:${kind}:${rootId}:${parentId}`;
  if(!cache.has(key))cache.set(key,(async()=>{for(const [id,path,hpath,marker] of [[rootId,`/${rootId}.sy`,'/思源工作台','root'],[parentId,`/${rootId}/${parentId}.sy`,`/思源工作台/${folderFor(kind)}`,markerFor(kind)]]){
    const location=await categoryPost(post,'/api/filetree/getPathByID',{id});if(location?.notebook!==notebookId||location.path!==path)throw new Error('工作台目录位置已更改');
    if(await categoryPost(post,'/api/filetree/getHPathByID',{id})!==hpath)throw new Error('工作台目录名称不匹配');
    const raw=await categoryPost(post,'/api/block/getBlockKramdown',{id});if(raw?.id!==id||typeof raw.kramdown!=='string'||!raw.kramdown.includes(`<!-- siyuan-workbench-folder:v1:${notebookId}:${marker} -->`))throw new Error('工作台目录标记不匹配');
  }})());await cache.get(key);
}
export async function assertCategoryFolder({notebookId,kind,rootId,parentId,id,post,cache=new Map()}){
  await assertKindFolder({notebookId,kind,rootId,parentId,post,cache});
  const key=`category:${notebookId}:${kind}:${rootId}:${parentId}:${id}`;
  if(!cache.has(key))cache.set(key,(async()=>{
    const location=await categoryPost(post,'/api/filetree/getPathByID',{id});if(location?.notebook!==notebookId||location.path!==`/${rootId}/${parentId}/${id}.sy`)throw new Error('分类目录不在对应工作台目录');
    const raw=await categoryPost(post,'/api/block/getBlockKramdown',{id});if(raw?.id!==id||typeof raw.kramdown!=='string')throw new Error('分类目录响应无效');
    const category=categoryFromMarker(raw.kramdown,notebookId,kind);if(category===null)throw new Error('目录不是受管分类');
    if(await categoryPost(post,'/api/filetree/getHPathByID',{id})!==`/思源工作台/${folderFor(kind)}/${categoryFolderTitle(category)}`)throw new Error('分类目录名称已变化');return category;
  })());return cache.get(key);
}
export async function assertWorkbenchLocation({notebookId,id,kind,post,cache=new Map(),location}){
  if(!isValidNodeID(id))throw new Error('记录ID无效');location=location||await categoryPost(post,'/api/filetree/getPathByID',{id});
  const parts=typeof location?.path==='string'?location.path.split('/').filter(Boolean):[];
  if(location?.notebook!==notebookId||![3,4].includes(parts.length)||parts.at(-1)!==id+'.sy'||!parts.slice(0,-1).every(isValidNodeID))throw new Error('记录不在所选笔记本的工作台直属或分类目录');
  const [rootId,kindFolderId,categoryFolderId]=parts;
  await assertKindFolder({notebookId,kind,rootId,parentId:kindFolderId,post,cache});
  const category=parts.length===4?await assertCategoryFolder({notebookId,kind,rootId,parentId:kindFolderId,id:categoryFolderId,post,cache}):null;
  return {...location,rootId,kindFolderId,categoryFolderId:parts.length===4?categoryFolderId:null,category};
}
export async function ensureCategoryFolder({notebookId,kind,category,parentId,rootId,post}){
  await assertKindFolder({notebookId,kind,rootId,parentId,post});
  const id=categoryFolderID(notebookId,kind,category),marker=categoryFolderMarker(notebookId,kind,category);
  try{await categoryPost(post,'/api/filetree/createDocByParent',{notebook:notebookId,parentID:parentId,id,title:{format:'plain',text:categoryFolderTitle(category)},markdown:marker});}
  catch(error){if(error.data?.commitState!=='none'&&error.data?.commitState!=='committed'){error.commitState='unknown';error.documentID=id;throw error;}}
  const actual=await assertCategoryFolder({notebookId,kind,rootId,parentId,id,post});if(actual!==normalizeCategory(category))throw new Error('分类目录ID发生碰撞，未覆盖已有目录');return id;
}
export async function moveRecordToCategory({notebookId,id,kind,category,post,expectedPath,expectedMarkdown}){
  let location=await assertWorkbenchLocation({notebookId,id,kind,post});
  if(expectedPath!==undefined&&location.path!==expectedPath)throw new Error('记录位置与整理预览不一致，请重新预览');
  const before=await categoryPost(post,'/api/block/getBlockKramdown',{id});if(before?.id!==id||typeof before.kramdown!=='string')throw new Error('无法核对移动前正文');
  if(expectedMarkdown!==undefined&&before.kramdown!==expectedMarkdown)throw new Error('记录正文与整理预览不一致，请重新预览');
  if(location.categoryFolderId&&location.category===normalizeCategory(category))return {id,organized:true,moved:false};
  const children=await categoryPost(post,'/api/filetree/listDocsByPath',{notebook:notebookId,path:location.path,showHidden:true,maxListCount:1});
  if(children?.box!==notebookId||children.path!==location.path||!Array.isArray(children.files)||children.files.length)throw new Error('记录包含子文档或范围无法确认，请先在原生文档树整理');
  const target=await ensureCategoryFolder({notebookId,kind,category,rootId:location.rootId,parentId:location.kindFolderId,post});
  const fresh=await assertWorkbenchLocation({notebookId,id,kind,post});
  const freshRaw=await categoryPost(post,'/api/block/getBlockKramdown',{id});
  if(fresh.path!==location.path||freshRaw?.id!==id||freshRaw.kramdown!==before.kramdown)throw new Error('移动前记录已变化，请重新核查');
  const finalChildren=await categoryPost(post,'/api/filetree/listDocsByPath',{notebook:notebookId,path:fresh.path,showHidden:true,maxListCount:1});
  if(finalChildren?.box!==notebookId||finalChildren.path!==fresh.path||!Array.isArray(finalChildren.files)||finalChildren.files.length)throw new Error('移动前新增了子文档或范围无法确认，未移动');
  try{await categoryPost(post,'/api/filetree/moveDocsByID',{fromIDs:[id],toID:target});}
  catch(error){error.commitState=error.data?.commitState==='none'?'none':'unknown';error.documentID=id;error.data={...error.data,commitState:error.commitState,id};throw error;}
  try{
    await categoryPost(post,'/api/sqlite/flushTransaction',{});
    location=await assertWorkbenchLocation({notebookId,id,kind,post});
    if(location.categoryFolderId!==target)throw new Error('移动后分类目录未确认');
    const after=await categoryPost(post,'/api/block/getBlockKramdown',{id});
    const comparable=md=>md.split('\n').map(line=>line.startsWith(`{: id="${id}"`)&&line.includes('type="doc"')?line.replace(/ updated="\d{14}"/,''):line).join('\n');
    if(after?.id!==id||typeof after.kramdown!=='string'||comparable(after.kramdown)!==comparable(before.kramdown))throw new Error('移动后原生正文或属性不一致');
    return {id,organized:true,moved:true};
  }catch(error){error.commitState='committed';error.documentID=id;error.data={...error.data,commitState:'committed',id};throw error;}
}
