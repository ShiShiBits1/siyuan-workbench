/** Flush indexed writes before refreshing mounted views, with one trailing
 * refresh for notifications received while a previous round is in flight. */
export function createWorkspaceRefreshScheduler({flush,refresh,isDisposed=()=>false,onError=()=>{}}) {
    let disposed=false,dirty=false,operation=null;
    const stopped=()=>disposed||isDisposed();
    function notify() {
        if(stopped())return Promise.resolve();
        dirty=true;
        if(operation)return operation;
        operation=Promise.resolve().then(async()=>{
            try {
                while(dirty&&!stopped()) {
                    dirty=false;
                    try {
                        await flush();
                        if(stopped())break;
                        await refresh();
                    } catch(error) {
                        try {await onError(error);}catch{/* Reporting cannot strand later refreshes. */}
                    }
                }
            } finally {operation=null;}
        });
        return operation;
    }
    return {notify,dispose(){disposed=true;dirty=false;}};
}
