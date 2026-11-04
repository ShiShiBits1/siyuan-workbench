/** The native dock owns visibility; this host owns only its view subscriptions.
 * Register synchronously so restored docks can find their model during startup.
 * Hiding a dock never destroys the shared module timer.
 */
export function createPomodoroDockHost({register,ready=Promise.resolve(),mount,onError=()=>{},unregister}={}){
  if(typeof register!=='function'||typeof mount!=='function')throw new Error('番茄钟侧栏注册参数无效');
  const hosts=new Map();let disposed=false;
  const cleanupHost=host=>{if(!host.alive)return;host.alive=false;hosts.delete(host.model);const cleanup=host.cleanup;host.cleanup=null;cleanup?.();};
  const descriptor=register({
    init:function(custom){
      const model=custom||this;if(disposed||hosts.get(model)?.alive)return;
      const host={model,alive:true,cleanup:null};hosts.set(model,host);
      Promise.resolve().then(()=>typeof ready==='function'?ready():ready).then(()=>{
        if(disposed||!host.alive)return null;
        return mount(model);
      }).then(result=>{
        const cleanup=typeof result==='function'?result:typeof result?.dispose==='function'?()=>result.dispose():null;
        if(disposed||!host.alive)cleanup?.();else host.cleanup=cleanup;
      }).catch(error=>{if(!disposed&&host.alive)onError(error,model);});
    },
    destroy:function(custom){const host=hosts.get(custom||this);if(host)cleanupHost(host);},
  });
  return {hosts,descriptor,isAlive:model=>!disposed&&Boolean(hosts.get(model)?.alive),
    dispose(){if(disposed)return;disposed=true;for(const host of [...hosts.values()])cleanupHost(host);if(descriptor?.id&&typeof unregister==='function')unregister(descriptor.id);},
  };
}
