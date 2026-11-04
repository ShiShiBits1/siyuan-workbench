/** Move only the exact generated ownership paragraph into a native attribute. */
export async function prepareProjectBody({notebookId,avId,documentId,post}) {
  const api=async(path,body)=>{const result=await post(path,body);if(result?.code!==0)throw new Error(result?.msg||'无法核对项目正文');return result.data;};
  const info=await api('/api/block/getBlockInfo',{id:documentId});
  if(info?.box!==notebookId||info.rootID!==documentId)throw new Error('项目已移出当前笔记本，请刷新核查。');
  const marker=`<!-- siyuan-workbench-project:${avId}:${documentId} -->`;
  const blocks=await api('/api/block/getChildBlocks',{id:documentId});
  const first=blocks?.[0];
  if(first?.type!=='p'||first.content!==marker)return;
  if(!/^\d{14}-[a-z0-9]{7}$/.test(first.id))throw new Error('项目生成标记无效，请在原文核查。');
  const attrs=await api('/api/attr/getBlockAttrs',{id:documentId});
  const origin=attrs?.['custom-workbench-project-origin'];
  if(origin&&origin!==`${avId}:${documentId}`)throw new Error('项目正文归属标记已被修改，请在原文核查。');
  await api('/api/attr/setBlockAttrs',{id:documentId,attrs:{'custom-workbench-project-origin':`${avId}:${documentId}`}});
  await api('/api/sqlite/flushTransaction',{});
  const latest=(await api('/api/block/getChildBlocks',{id:documentId}))?.[0];
  if(latest?.id!==first.id||latest.type!=='p'||latest.content!==marker)throw new Error('项目正文已发生变化，请重新打开核查。');
  const current=await api('/api/block/getBlockInfo',{id:documentId});
  if(current?.box!==notebookId||current.rootID!==documentId)throw new Error('项目位置已变化，请重新打开核查。');
  await api('/api/block/deleteBlock',{id:first.id});
  await api('/api/sqlite/flushTransaction',{});
}
