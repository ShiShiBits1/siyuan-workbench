import {isAttachmentAssetPath} from './task-attachment-upload.js';

const NATIVE_MEDIA = /\.(?:png|jpg|jpeg|gif|webp|bmp|svg|avif|ico|mp3|wav|ogg|m4a|flac|mp4|webm|mov)$/i;

// Unsupported office/document formats are downloaded, never passed to asset tabs.
export function createAttachmentOpener({app,open,download}) {
    return async path => {
        if(!isAttachmentAssetPath(path))throw new Error('此路径不是可打开的思源附件；原附件引用已保留');
        const decoded=decodeURIComponent(path);
        if(!/\.pdf$/i.test(decoded)&&!NATIVE_MEDIA.test(decoded)) {
            if(typeof download!=='function')throw new Error('此格式需要下载原文件，当前下载入口不可用');
            await download(path);
            return {mode:'download'};
        }
        const options={app,openNewTab:true};
        if(/\.pdf$/i.test(decoded))options.pdf={path};
        else options.asset={path};
        return open(options);
    };
}

export function createAttachmentDownloader({document}) {
    return path=>{
        if(!isAttachmentAssetPath(path))throw new Error('此路径不是可下载的思源附件');
        const parts=decodeURIComponent(path).split('/');
        const anchor=document.createElement('a');
        anchor.href='/'+parts.map(part=>encodeURIComponent(part)).join('/');
        anchor.download=parts.at(-1);
        anchor.hidden=true;
        document.body.appendChild(anchor);
        try { anchor.click(); } finally { anchor.remove(); }
    };
}
