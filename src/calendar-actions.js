/** Calendar writes keep planned IDs on their draft and synchronize native indexes before refreshing views. */
export function createCalendarActions({repository,planner,runWrite,flush,isDisposed=()=>false,onChanged=()=>{},canDelete=()=>{}}) {
    const reject=message=>{throw Object.assign(new Error(message),{commitState:'none'});};
    async function mutate(operation,{synchronize=true}={}) {
        return runWrite(repository.notebookId,async()=>{
            const saved=await operation();
            if(isDisposed())return saved;
            if(synchronize){
                try{await flush();}
                catch(failure){
                    const error=new Error(`日程已保存，但列表同步失败，请先刷新核查：${failure?.message||'思源未确认写入队列'}`);
                    error.commitState='committed';error.documentID=saved.id;error.data={commitState:'committed',id:saved.id};throw error;
                }
            }
            if(!isDisposed())onChanged();
            return saved;
        });
    }
    return {
        createEvent(draft){
            if(!draft||draft.kind!=='event')reject('日历仅支持新建日程');
            return mutate(()=>repository.create(draft));
        },
        updateEvent(id,patch,options){return mutate(()=>planner.patchEvent(id,patch,options));},
        deleteEvent(id,options){return mutate(()=>{canDelete();return planner.deleteEvent(id,options);},{synchronize:false});},
    };
}
