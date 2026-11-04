/** A completed native delete must not let an unloaded plugin rewrite a later clock configuration. */
export async function deleteTaskAndRefresh({remove,isDisposed,detachTarget,persistClock,notify,onPersistenceError}) {
    const result=await remove();
    if(isDisposed())return result;
    if(detachTarget()){
        try{await persistClock();}
        catch(error){if(!isDisposed())onPersistenceError(error);}
    }
    if(!isDisposed())notify();
    return result;
}
