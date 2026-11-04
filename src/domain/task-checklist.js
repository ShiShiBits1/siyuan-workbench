/** One-level task steps. Extra fields belong to the user or future versions. */
export function normalizeChecklist(input) {
  if(!Array.isArray(input)||input.length>100)throw new Error('任务步骤必须为最多100项的列表');
  const ids=new Set();
  return input.map(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item)||typeof item.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(item.id)||ids.has(item.id))throw new Error('任务步骤ID无效或重复');
    if(typeof item.title!=='string'||!item.title.trim()||item.title.length>500||typeof item.done!=='boolean')throw new Error('任务步骤标题或完成状态无效');
    ids.add(item.id);return {...item,title:item.title.trim()};
  });
}
export function checklistProgress(task) {
  const items=normalizeChecklist(task?.checklist??[]),completed=items.filter(item=>item.done).length;
  return {total:items.length,completed,next:items.find(item=>!item.done)||null};
}
