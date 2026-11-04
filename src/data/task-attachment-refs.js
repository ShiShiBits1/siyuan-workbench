import {isAttachmentAssetPath} from '../task-attachment-upload.js';

const PREFIX = 'custom-data-assets-workbench-v1-';
const OWNED_KEY = /^custom-data-assets-workbench-v1-(?:0|[1-9]\d*)$/;

// Native unreferenced-asset scanning includes custom-data-assets* IAL on document blocks.
// Each value is one path, so filenames with spaces never depend on list splitting.
export function taskAttachmentRefAttrs(paths, previous = {}) {
    const assets = [...new Set((Array.isArray(paths) ? paths : []).filter(isAttachmentAssetPath))];
    const attrs = Object.fromEntries(assets.map((path, index) => [PREFIX + index, path]));
    for (const key of Object.keys(previous || {})) {
        if (OWNED_KEY.test(key) && !Object.hasOwn(attrs, key)) attrs[key] = '';
    }
    return attrs;
}

export async function syncTaskAttachmentRefs({post, id, attachmentPaths}) {
    const response = await post('/api/attr/getBlockAttrs', {id});
    if (response?.code !== 0 || !response.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
        throw new Error(response?.msg || '思源未确认附件引用属性，需核查任务保存结果');
    }
    const attrs = taskAttachmentRefAttrs(attachmentPaths, response.data);
    if (Object.keys(attrs).length) {
        const saved = await post('/api/attr/setBlockAttrs', {id, attrs});
        if (saved?.code !== 0) throw new Error(saved?.msg || '思源未确认附件引用属性保存，需核查任务保存结果');
    }
}
