const allowed=new Set('P BR HR H1 H2 H3 H4 H5 H6 STRONG B EM I S DEL MARK SUB SUP UL OL LI BLOCKQUOTE PRE CODE TABLE THEAD TBODY TFOOT TR TH TD A'.split(' '));
const discard=new Set('SCRIPT STYLE IFRAME FRAME FRAMESET OBJECT EMBED SVG MATH TEMPLATE NOSCRIPT LINK META BASE FORM INPUT BUTTON TEXTAREA SELECT OPTION AUDIO VIDEO SOURCE TRACK CANVAS'.split(' '));
function safeHref(value) {
  const href=String(value||'').trim();
  if(/^siyuan:\/\/blocks\/\d{14}-[a-z0-9]{7}$/.test(href))return href;
  if(/^#[a-zA-Z0-9_-]+$/.test(href))return href;
  try {const url=new URL(href);return ['http:','https:','mailto:'].includes(url.protocol)?url.href:null;}catch{return null;}
}
/** Parse in an inert template, then copy only safe semantic nodes to the live DOM. */
export function sanitizeAgentMarkdownHTML(document,html) {
  const template=document.createElement('template');template.innerHTML=String(html);
  const fragment=document.createDocumentFragment();
  function append(source,target) {
    if(source.nodeType===3){target.append(document.createTextNode(source.nodeValue||''));return;}
    if(source.nodeType!==1)return;
    const tag=source.tagName.toUpperCase();
    if(tag==='IMG'){target.append(document.createTextNode(`[图片${source.getAttribute('alt')?'：'+source.getAttribute('alt'):''}]`));return;}
    if(discard.has(tag))return;
    if(!allowed.has(tag)){for(const child of source.childNodes)append(child,target);return;}
    const node=document.createElement(tag.toLowerCase());
    if(tag==='A'){
      const href=safeHref(source.getAttribute('href'));
      if(href){node.setAttribute('href',href);node.setAttribute('rel','noopener noreferrer');if(/^https?:/i.test(href))node.setAttribute('target','_blank');}
    }
    if(tag==='OL') {const start=source.getAttribute('start');if(/^-?\d{1,6}$/.test(start||''))node.setAttribute('start',start);}
    if(tag==='TD'||tag==='TH')for(const key of ['colspan','rowspan']){const value=Number(source.getAttribute(key));if(Number.isInteger(value)&&value>0&&value<=100)node.setAttribute(key,String(value));}
    for(const child of source.childNodes)append(child,node);
    target.append(node);
  }
  for(const child of template.content.childNodes)append(child,fragment);
  return fragment;
}
export function createAgentMarkdownRenderer(document,{lute=document.defaultView?.Lute??globalThis.Lute}={}) {
  let engine;
  try {engine=lute?.New?.();engine?.SetSanitize?.(true);engine?.SetHeadingID?.(false);}catch{engine=null;}
  return (target,markdown)=>{
    const source=String(markdown??'');
    try {
      const html=typeof engine?.Md2HTML==='function'?engine.Md2HTML(source):typeof engine?.MarkdownStr==='function'?engine.MarkdownStr('',source):null;
      if(typeof html!=='string')throw new Error('Markdown renderer unavailable');
      const safe=sanitizeAgentMarkdownHTML(document,html);
      target.replaceChildren(safe);target.classList.add('swa__markdown');
    }catch{target.textContent=source;target.classList.remove('swa__markdown');}
  };
}
