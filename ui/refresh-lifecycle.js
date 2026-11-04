/** Visible-only clock recomputation and coalesced read-only resume notifications.
 * Callbacks must check signal/isCurrent after awaiting before applying results.
 */
export function createVisibleRefresh({document,onClock=()=>{},onResume=()=>{},intervalMs=60000,debounceMs=80,timers=globalThis}={}){
  if(!document?.addEventListener)throw new Error('刷新生命周期需要有效文档');
  if(!Number.isFinite(intervalMs)||intervalMs<=0||!Number.isFinite(debounceMs)||debounceMs<0)throw new Error('刷新间隔无效');
  let disposed=false,debounce=null;
  const window=document.defaultView;
  const visible=()=>!disposed&&document.visibilityState==='visible';
  // Clock and I/O each keep one trailing notification, never overlapping themselves.
  const lanes=[{callback:onClock,pending:false,active:null},{callback:onResume,pending:false,active:null}];
  function drain(lane){
    if(!visible()){lane.pending=false;return;}
    if(lane.active){lane.pending=true;return;}
    lane.pending=false;
    const controller=new AbortController();lane.active=controller;
    const context={signal:controller.signal,isCurrent:()=>visible()&&lane.active===controller&&!controller.signal.aborted};
    // Enter through a promise so synchronous throws and asynchronous rejections
    // share the same cleanup; a rejected callback cannot leak to the host.
    void Promise.resolve().then(()=>{if(context.isCurrent())return lane.callback(context);}).catch(()=>{}).finally(()=>{
      if(lane.active!==controller)return;
      lane.active=null;
      if(!visible()){lane.pending=false;return;}
      if(lane.pending)drain(lane);
    });
  }
  function resume(){
    if(!visible())return;
    if(debounce!==null)timers.clearTimeout(debounce);
    debounce=timers.setTimeout(()=>{debounce=null;if(visible())drain(lanes[1]);},debounceMs);
  }
  function visibility(){
    if(visible()){resume();return;}
    if(debounce!==null){timers.clearTimeout(debounce);debounce=null;}
    for(const lane of lanes){lane.pending=false;lane.active?.abort();}
  }
  const tick=timers.setInterval(()=>{if(visible())drain(lanes[0]);},intervalMs);
  document.addEventListener('visibilitychange',visibility);
  window?.addEventListener('focus',resume);
  return function dispose(){
    if(disposed)return;disposed=true;
    timers.clearInterval(tick);
    if(debounce!==null)timers.clearTimeout(debounce);
    document.removeEventListener('visibilitychange',visibility);
    window?.removeEventListener('focus',resume);
    for(const lane of lanes){lane.pending=false;lane.active?.abort();lane.active=null;}
  };
}
