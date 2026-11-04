import {isValidNodeID,newNodeID} from './data/node-id.js';

// Shared between workbench tabs. Different drafts for the same record must not
// join a write whose payload they did not submit.
const activeWrites=new Set(),unconfirmedWrites=new Map();
const reject=message=>{throw Object.assign(new Error(message),{commitState:'none'});};

/** Synchronize the native derived index before allowing any view refresh. */
export function createWorkbenchRecordActions({repository,planner,runWrite,flush,isDisposed=()=>false,onChanged=()=>{}}){
    async function mutate(id,operation,{creating=false}={}){
        const key=repository.notebookId+':'+id;
        if(activeWrites.has(key))reject('此记录正在保存，请等待完成后再操作；当前草稿已保留');
        if(creating&&unconfirmedWrites.has(key))throw unconfirmedWrites.get(key);
        activeWrites.add(key);
        try{
            return await runWrite(repository.notebookId,async()=>{
                const saved=await operation();
                if(isDisposed())return saved;
                try{await flush();}
                catch(failure){
                    const error=new Error('记录已保存，但列表同步失败，请先刷新核查：'+(failure?.message||'思源未确认写入队列'));
                    error.commitState='committed';error.documentID=saved.id;error.stage='index-sync';
                    error.data={commitState:'committed',id:saved.id};throw error;
                }
                if(!isDisposed()){
                    // Refresh can include this very form. Never wait for it or
                    // turn a refresh failure into a failed document write.
                    try{void Promise.resolve(onChanged()).catch(()=>{});}catch{}
                }
                return saved;
            });
        }catch(error){
            if(creating&&['unknown','committed'].includes(error?.commitState??error?.data?.commitState))unconfirmedWrites.set(key,error);
            throw error;
        }finally{activeWrites.delete(key);}
    }
    return {
        saveRecord(draft){
            if(!draft||typeof draft!=='object'||!['task','event'].includes(draft.kind))reject('任务或日程草稿无效');
            const creating=!draft.id||!!draft._pendingCreate;
            if(creating){draft.id ||= newNodeID();draft.docId=draft.id;draft._pendingCreate=true;}
            const id=draft.id;
            if(!isValidNodeID(id))reject('记录 ID 无效');
            // Freeze this operation's input, while retaining its planned ID on
            // the caller draft even when the workspace gate rejects a write.
            const input=structuredClone(draft);
            return mutate(id,()=>creating?repository.create(input):repository.update(id,input),{creating});
        },
        patchTask(id,patch,options){
            if(!isValidNodeID(id))reject('任务 ID 无效');
            const input=structuredClone(patch),expected=options===undefined?undefined:structuredClone(options);
            return mutate(id,()=>planner.patchTask(id,input,expected));
        },
    };
}
