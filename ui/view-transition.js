/** Enter-only motion preserves mounted views, focus and immediate ARIA state. */
export function createViewTransition(window) {
  let animation=null;
  return {show(node){
    animation?.cancel();animation=null;
    if(!node||window?.matchMedia?.('(prefers-reduced-motion: reduce)').matches||typeof node.animate!=='function')return;
    animation=node.animate([{opacity:0,transform:'translateY(4px)'},{opacity:1,transform:'translateY(0)'}],{duration:170,easing:'cubic-bezier(.2,.7,.2,1)'});
  },dispose(){animation?.cancel();animation=null;}};
}
