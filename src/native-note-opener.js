/** Share creation/reopen attempts across all workbench views without replaying a successful create. */
export function createNativeNoteOpener({create,open,assertAvailable=()=>{},onCreated=()=>{}}) {
    const pending=new Map(),active=new Map();
    return {
        get busy(){return active.size>0;},
        open(notebookId){
            if(active.has(notebookId))return active.get(notebookId);
            const operation=(async()=>{
                assertAvailable(notebookId);
                let entry=pending.get(notebookId);
                if(!entry){entry={draft:{title:'未命名笔记',detail:''},saved:null,locked:null};pending.set(notebookId,entry);}
                if(entry.locked)throw entry.locked;
                if(!entry.saved){
                    try{
                        entry.saved=await create(notebookId,entry.draft);
                        if(!entry.saved?.id||entry.saved.id!==entry.draft.id)throw Object.assign(new Error('笔记创建结果尚未确认，请先在思源中核查'),{commitState:'unknown',documentID:entry.draft.id});
                    }catch(failure){
                        entry.saved=null;
                        const state=failure?.commitState??failure?.data?.commitState;
                        if(state==='unknown'){
                            const error=new Error(`笔记保存结果待核查（ID：${failure.documentID||entry.draft.id||'未知'}）。已停止重复创建，请先在思源中检查文档。`);
                            error.commitState='unknown';error.documentID=failure.documentID||entry.draft.id;entry.locked=error;throw error;
                        }
                        if(state==='none')entry.draft={title:'未命名笔记',detail:''};
                        throw failure;
                    }
                    await onCreated(entry.saved);
                }
                try{
                    assertAvailable(notebookId);
                    await open(entry.saved.id);
                }catch(failure){
                    const error=new Error(`笔记已创建（ID：${entry.saved.id}），但原生编辑器未打开：${failure?.message||'请重试'}。再次点击“新建笔记”将重新打开这篇笔记。`);
                    error.commitState='committed';error.documentID=entry.saved.id;throw error;
                }
                pending.delete(notebookId);
                return entry.saved;
            })().finally(()=>active.delete(notebookId));
            active.set(notebookId,operation);return operation;
        },
    };
}
