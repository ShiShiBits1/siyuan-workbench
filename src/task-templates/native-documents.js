import {isValidNodeID,newNodeID,stableNodeID} from '../data/node-id.js';

const locks=new Set();
export function createNativeDefinitionStore({notebookId,post,kind,folderName,now=()=>new Date()}) {
  if(!isValidNodeID(notebookId)||typeof post!=='function'||!['task-template','task-series'].includes(kind))throw new Error('定义存储参数无效');
  const root=stableNodeID(`${notebookId}:siyuan-workbench:root`),folder=stableNodeID(`${notebookId}:siyuan-workbench:${kind}`);
  const marker='workbench-'+kind;
  const api=async(path,body)=>{const r=await post(path,body);if(r?.code!==0)throw Object.assign(new Error(r?.msg||'思源未确认操作'),{data:r?.data});return r.data;};
  const raw=async id=>{const r=await api('/api/block/getBlockKramdown',{id});if(r?.id!==id||typeof r.kramdown!=='string')throw new Error('定义文档身份不匹配');return r.kramdown;};
  async function location(id){const p=await api('/api/filetree/getPathByID',{id});if(p?.notebook!==notebookId||p.path!==`/${root}/${folder}/${id}.sy`)throw new Error('定义已移出当前笔记本目录');}
  function decode(text,id){const token='```'+marker+'\n',at=text.indexOf(token);if(at<0||text.indexOf(token,at+token.length)>=0)throw new Error('定义标记缺失或不唯一');const end=text.indexOf('\n```',at+token.length);if(end<0)throw new Error('定义标记未闭合');const value=JSON.parse(text.slice(at+token.length,end));if(value?.id!==id||value?.kind!==kind||value?.notebookId!==notebookId)throw new Error('定义身份不匹配');return {value,at:at+token.length,end};}
  async function get(id){if(!isValidNodeID(id))throw new Error('定义ID无效');await location(id);const attrs=await api('/api/attr/getBlockAttrs',{id});if(attrs?.['custom-workbench-type']&&attrs['custom-workbench-type']!==kind)throw new Error('定义类型已更改');if(attrs?.['custom-workbench-id']&&attrs['custom-workbench-id']!==id)throw new Error('定义属性身份已更改');return decode(await raw(id),id).value;}
  async function ensure(id,parentID,title,text,recover){
    let result,creationError;
    try{result=await api('/api/filetree/createDocByParent',{notebook:notebookId,parentID,id,title:{format:'plain',text:title},markdown:text});}
    catch(error){creationError=error;}
    const actual=result?.id||result?.document?.id;if(actual&&actual!==id)throw new Error('返回文档ID不符');
    // An existing:true success is also a recovery, not permission to relabel it.
    // Verify even a fresh success before writing attributes; preserve saved times.
    try{return await recover(await raw(id));}
    catch(error){if(creationError)error.cause=creationError;throw error;}
  }
  async function assertFolder(id,parentID,text,knownLocation){
    const current=knownLocation||await api('/api/filetree/getPathByID',{id});
    if(current?.notebook!==notebookId||current.path!==(parentID?`/${parentID}/${id}.sy`:`/${id}.sy`))throw new Error('工作台定义目录位置已更改');
    const markers=(await raw(id)).match(/<!-- siyuan-workbench-(?:definition-)?folder:v1:[^\r\n]*? -->/g)||[];
    if(markers.length!==1||markers[0]!==text)throw new Error('工作台定义目录标记不匹配或不唯一');
  }
  async function ensureFolder(id,parentID,title,text){
    const found=await post('/api/filetree/getPathByID',{id});
    if(found?.code===0){await assertFolder(id,parentID,text,found.data);return;}
    let creationError;
    try{const result=await api('/api/filetree/createDocByParent',{notebook:notebookId,parentID,id,title:{format:'plain',text:title},markdown:text});const actual=result?.id||result?.document?.id;if(actual&&actual!==id)throw new Error('返回文档ID不符');}
    catch(error){creationError=error;}
    try{await assertFolder(id,parentID,text);}catch(error){if(creationError)error.cause=creationError;throw error;}
  }
  async function folders(){
    const rootMarker=`<!-- siyuan-workbench-folder:v1:${notebookId}:root -->`,folderMarker=`<!-- siyuan-workbench-definition-folder:v1:${notebookId}:${kind} -->`;
    await ensureFolder(root,null,'思源工作台',rootMarker);await ensureFolder(folder,root,folderName,folderMarker);
    await assertFolder(root,null,rootMarker);await assertFolder(folder,root,folderMarker);
  }
  async function list(){const result=[];for(let offset=0;;offset+=500){const rows=await api('/api/query/sql',{mode:'readonly',stmt:`SELECT id FROM blocks WHERE type='d' AND box='${notebookId}' AND path LIKE '/${root}/${folder}/%' AND id IN (SELECT block_id FROM attributes WHERE name='custom-workbench-type' AND value='${kind}') ORDER BY id LIMIT 500 OFFSET ${offset}`});if(!Array.isArray(rows))throw new Error('定义列表格式无效');for(const row of rows){if(!isValidNodeID(row.id)||result.some(v=>v.id===row.id))throw new Error('定义列表身份异常');const attrs=await api('/api/attr/getBlockAttrs',{id:row.id});if(attrs?.['custom-workbench-type']===kind&&attrs?.['custom-workbench-id']===row.id)result.push(await get(row.id));}if(rows.length<500)break;}return result;}
  async function upsert(input,{expectedUpdatedAt}={}){
    input.id ||= newNodeID();const submitted=structuredClone(input),id=submitted.id,key=notebookId+':'+id;if(!isValidNodeID(id)||locks.has(key))throw new Error('定义正在保存或ID无效');locks.add(key);
    try{
      let previous=null;if(expectedUpdatedAt!==undefined){previous=await get(id);if(previous.updatedAt!==expectedUpdatedAt)throw new Error('定义已被修改，请重新加载');}
      const stamp=new Date(Math.max(now().getTime(),previous?Date.parse(previous.updatedAt)+1:0)).toISOString();let value={...previous,...submitted,id,notebookId,kind,createdAt:previous?.createdAt||submitted.createdAt||stamp,updatedAt:stamp};let writeStarted=false,confirmed=false;
      try{
        if(!previous){await folders();writeStarted=true;const recovered=await ensure(id,folder,value.name||'未命名定义',`# ${(value.name||'未命名定义').replace(/[\r\n]/g,' ')}\n\n\`\`\`${marker}\n${JSON.stringify(value,null,2)}\n\`\`\``,async()=>{const existing=await get(id);for(const key of Object.keys(submitted)){if(['id','createdAt','updatedAt'].includes(key))continue;if(JSON.stringify(existing[key])!==JSON.stringify(submitted[key]))throw new Error('同一ID定义内容不同，请先核查');}return existing;});if(recovered)value=recovered;confirmed=true;}
        else{
          const blocks=await api('/api/block/getChildBlocks',{id});if(!Array.isArray(blocks))throw new Error('定义子块无效');let selected;
          for(const b of blocks){if(b.type!=='c')continue;const text=await raw(b.id);if(text.includes('```'+marker+'\n')){if(selected)throw new Error('定义机器块不唯一');selected={id:b.id,text};}}
          if(!selected)throw new Error('定义机器块缺失');const parsed=decode(selected.text,id);if(parsed.value.updatedAt!==expectedUpdatedAt)throw new Error('定义已被修改');await location(id);if(await raw(selected.id)!==selected.text)throw new Error('定义内容在保存前已更改');
          writeStarted=true;await api('/api/block/updateBlock',{id:selected.id,dataType:'markdown',data:selected.text.slice(0,parsed.at)+JSON.stringify(value,null,2)+selected.text.slice(parsed.end)});confirmed=true;
        }
        await api('/api/attr/setBlockAttrs',{id,attrs:{'custom-workbench-type':kind,'custom-workbench-id':id}});await api('/api/sqlite/flushTransaction',{});
        const saved=await get(id);if(JSON.stringify(saved)!==JSON.stringify(value))throw new Error('定义保存结果需核查');return saved;
      }catch(error){if(writeStarted){error.commitState=confirmed?'committed':'unknown';error.documentID=id;error.message='定义'+(confirmed?'已保存但后续未确认':'可能已保存')+'，请核查同一ID后继续：'+error.message;}throw error;}
    }finally{locks.delete(key);}
  }
  return {list,get,upsert};
}
