import {toolPath} from './package.js';
export const TOOL_SANDBOX='allow-scripts';
export const TOOL_CSP="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
const attr=(text,key)=>text.match(new RegExp('\\b'+key+'\\s*=\\s*(["\'])(.*?)\\1','i'))?.[2];
function localFile(files,entry,ref,ext){if(!ref||/[?#:]/.test(ref)||ref.startsWith('/'))throw Error('工具资源必须使用本地相对路径');const path=toolPath(entry.split('/').slice(0,-1).concat(ref.replace(/^\.\//,'')).join('/'));if(!path.endsWith(ext)||!Object.hasOwn(files,path))throw Error('工具本地资源不存在');return files[path];}
export function buildToolDocument(pkg){
    let html=pkg.files[pkg.manifest.entry];
    if(/<(?:base|iframe|frame|object|embed|form)\b|<meta\b[^>]*http-equiv\s*=/i.test(html))throw Error('工具HTML包含不支持的导航、嵌套或表单元素');
    html=html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,(_,attrs,body)=>{
        if(/\btype\s*=\s*(["'])module\1/i.test(attrs))throw Error('首版工具请打包为普通JS，不支持模块导入');
        const src=attr(attrs,'src');if(/\bsrc\s*=/i.test(attrs)&&!src)throw Error('脚本src必须加引号');
        const code=src?localFile(pkg.files,pkg.manifest.entry,src,'.js'):body;
        return '<script>'+code.replace(/<\/script/gi,'<\\/script')+'</script>';
    });
    html=html.replace(/<link\b([^>]*)>/gi,(_,attrs)=>{if(attr(attrs,'rel')?.toLowerCase()!=='stylesheet')throw Error('工具仅支持本地样式表');return '<style>'+localFile(pkg.files,pkg.manifest.entry,attr(attrs,'href'),'.css').replace(/<\/style/gi,'<\\/style')+'</style>';});
    if(/\b(?:src|href)\s*=\s*(["'])\s*(?:https?:|\/\/|javascript:|data:text\/html)/i.test(html))throw Error('工具不支持远程资源或导航');
    return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+TOOL_CSP+'"></head><body>'+html+'</body></html>';
}
