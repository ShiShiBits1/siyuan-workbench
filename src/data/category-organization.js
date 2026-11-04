import {WorkbenchPlannerRepository} from './workbench-planner.js';
import {assertWorkbenchLocation,categoryFolderID,categoryFolderTitle,categoryPost,moveRecordToCategory,normalizeCategory} from './category-location.js';
export class CategoryOrganizerRepository{
  constructor(notebookId,{post}={}){this.notebookId=notebookId;this.records=new WorkbenchPlannerRepository(notebookId,post?{post}:{});this.post=this.records.post;this.previews=new WeakMap();this.busy=new Set();}
  async plan(){
    const records=[...await this.records.listTasks(),...await this.records.listEvents()],items=[],cache=new Map();
    for(const record of records){
      const location=await assertWorkbenchLocation({notebookId:this.notebookId,id:record.id,kind:record.kind,post:this.post,cache});
      if(location.categoryFolderId&&location.category===normalizeCategory(record.category))continue;
      const response=await this.post('/api/block/getBlockKramdown',{id:record.id});if(response?.code!==0||response.data?.id!==record.id||typeof response.data.kramdown!=='string')throw new Error('整理预览无法读取原生正文');
      const target=categoryFolderID(this.notebookId,record.kind,record.category);
      const currentDisplayPath=await categoryPost(this.post,'/api/filetree/getHPathByID',{id:record.id});if(typeof currentDisplayPath!=='string')throw new Error('整理预览无法读取文档显示路径');
      const parentDisplayPrefix=`/思源工作台/${record.kind==='task'?'任务':'日程'}/${location.categoryFolderId?categoryFolderTitle(location.category)+'/':''}`;
      if(!currentDisplayPath.startsWith(parentDisplayPrefix))throw new Error('整理预览显示路径与所在目录不一致，请重新预览');
      const nativeTitle=currentDisplayPath.slice(parentDisplayPrefix.length);
      const item={id:record.id,title:record.title,kind:record.kind,category:record.category,currentPath:location.path,targetPath:`/${location.rootId}/${location.kindFolderId}/${target}/${record.id}.sy`,currentDisplayPath,targetDisplayPath:`/思源工作台/${record.kind==='task'?'任务':'日程'}/${categoryFolderTitle(record.category)}/${nativeTitle}`,expectedUpdatedAt:record.updatedAt};
      this.previews.set(item,{...item,markdown:response.data.kramdown,attempted:false});items.push(item);
    }
    return {notebookId:this.notebookId,items};
  }
  async execute(item){
    const preview=this.previews.get(item);
    if(!preview||preview.attempted)throw new Error('整理预览已失效或已执行，请重新预览核对');
    if(this.busy.has(item.id))throw new Error('该记录正在整理');
    preview.attempted=true;this.busy.add(item.id);
    try{
      for(const field of ['id','title','kind','category','currentPath','targetPath','currentDisplayPath','targetDisplayPath','expectedUpdatedAt'])if(item[field]!==preview[field])throw new Error('整理预览字段已更改，请重新预览');
      const current=await this.records.get(item.id);
      if(current.kind!==preview.kind||current.title!==preview.title||current.category!==preview.category||current.updatedAt!==preview.expectedUpdatedAt)throw new Error('记录在预览后已更新，请重新预览');
      return await moveRecordToCategory({notebookId:this.notebookId,id:item.id,kind:item.kind,category:item.category,post:this.post,expectedPath:preview.currentPath,expectedMarkdown:preview.markdown});
    }catch(error){if(!error.commitState)error.commitState='none';error.documentID=item.id;error.data={...error.data,commitState:error.commitState,id:item.id};throw error;}
    finally{this.busy.delete(item.id);}
  }
}
