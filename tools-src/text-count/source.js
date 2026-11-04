const manifest={schemaVersion:1,id:'text-count',name:'字符与行数统计',version:'1.0.0',author:'思源工作台',description:'统计文本Unicode字符、非空白字符与行数；内容只在当前工具页面内处理。',entry:'index.html',permissions:[]};
export default {manifest,files:{
    'tool.json':JSON.stringify(manifest,null,2),
    'index.html':'<h1>字符与行数统计</h1><p>按Unicode码点统计；组合字符可能包含多个码点。关闭页面不会保存输入。</p><label>待统计文本<textarea id="input" rows="12"></textarea></label><p id="result" role="status"></p><link rel="stylesheet" href="style.css"><script src="main.js"></script>',
    'style.css':'body{font:14px/1.65 system-ui,sans-serif;color:#223c33;background:#fff;padding:20px;margin:0}h1{font-size:21px}textarea{box-sizing:border-box;width:100%;padding:10px;border:1px solid #b8cbc3;border-radius:6px;font:inherit}label{display:block;margin:14px 0}#result{padding:14px;background:#edf5f1;border-radius:6px}:focus-visible{outline:2px solid #23765c;outline-offset:3px}',
    'main.js':'const input=document.querySelector("#input"),result=document.querySelector("#result");function update(){const text=input.value;result.textContent=`字符 ${Array.from(text).length} · 非空白 ${Array.from(text.replace(/\\s/g,"")).length} · 行数 ${text?text.split(/\\r?\\n/).length:0}`;}input.addEventListener("input",update);update();'
}};
