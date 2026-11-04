import {Protyle} from 'siyuan';

export function createNativeTaskEditor(app,element,record,onError=()=>{}) {
  return new Promise((resolve,reject)=>{
    let instance,finished=false;
    const timer=setTimeout(()=>{
      if(finished)return;
      finished=true;
      instance?.destroy();
      reject(new Error('正文编辑器加载超时，请重试或打开原文'));
    },12000);
    try {
      instance=new Protyle(app,element,{
        blockId:record.bodyId,
        databaseAttr:record.bodyId===record.documentId,
        render:{title:false,background:false,gutter:true,breadcrumb:false,scroll:true},
        after:editor=>{
          if(finished){editor.destroy();return;}
          finished=true;clearTimeout(timer);
          resolve({
            focus:()=>editor.focus(),
            resize:()=>editor.resize(),
            destroy:()=>editor.destroy(),
            dispose:()=>{
              Promise.resolve().then(()=>editor.flushPendingTransactions?.()).catch(onError).finally(()=>editor.destroy());
            },
            async flush(){
              if(editor.isUploading())throw new Error('附件正在上传，请稍后关闭页面');
              if(typeof editor.flushPendingTransactions!=='function')throw new Error('当前思源编辑器无法确认保存，请在原文中核查后关闭');
              await editor.flushPendingTransactions();
            },
          });
        },
      });
    } catch(error){finished=true;clearTimeout(timer);instance?.destroy();reject(error);}
  });
}
