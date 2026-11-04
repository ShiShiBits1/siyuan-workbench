const manifest={schemaVersion:1,id:'text-dedupe',name:'文本逐行去重',version:'1.0.0',author:'思源工作台',description:'保留首条出现顺序，对粘贴文本逐行去重；内容只在当前工具页面内处理。',entry:'index.html',permissions:[]};
export default {manifest,files:{
    'tool.json':JSON.stringify(manifest,null,2),
    'index.html':'<h1>文本逐行去重</h1><p>保留第一次出现的行。关闭页面前请自行复制结果。</p><label>原文<textarea id="input" rows="9"></textarea></label><button id="run">去重</button><label>结果<textarea id="output" rows="9" readonly></textarea></label><p id="status" role="status"></p><link rel="stylesheet" href="style.css"><script src="main.js"></script>',
    'style.css':'body{font:14px/1.65 system-ui,sans-serif;color:#223c33;background:#fff;padding:20px;margin:0}h1{font-size:21px}label{display:block;margin:14px 0}textarea{box-sizing:border-box;width:100%;padding:10px;border:1px solid #b8cbc3;border-radius:6px;font:inherit}button{background:#23765c;color:#fff;border:0;border-radius:6px;padding:10px 18px;cursor:pointer}:focus-visible{outline:2px solid #23765c;outline-offset:3px}',
    'main.js':'document.querySelector("#run").addEventListener("click",()=>{const lines=document.querySelector("#input").value.split(/\\r?\\n/);const unique=[...new Set(lines)];document.querySelector("#output").value=unique.join("\\n");document.querySelector("#status").textContent=`${lines.length} 行 → ${unique.length} 行`;});'
}};
