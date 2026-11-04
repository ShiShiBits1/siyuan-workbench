// One file per request also supports kernels whose succMap cannot represent duplicate names.
export function isAttachmentAssetPath(path) {
    if (typeof path !== 'string' || !path.startsWith('assets/')) return false;
    let decoded;
    try { decoded = decodeURIComponent(path); } catch { return false; }
    return !/[\\\u0000-\u001f\u007f?#]/.test(decoded)
        && decoded.split('/').every(part => part && part !== '.' && part !== '..');
}

function confirmedPath(data, name) {
    if (!data || typeof data !== 'object') return null;
    if ((Array.isArray(data.errFiles) && data.errFiles.length)
        || (Array.isArray(data.failedFiles) && data.failedFiles.length)) return null;
    if (Array.isArray(data.succFiles)) {
        if (data.succFiles.length !== 1) return null;
        const result = data.succFiles[0];
        return result?.index === 0 && result.name === name && isAttachmentAssetPath(result.path) ? result.path : null;
    }
    if (!data.succMap || typeof data.succMap !== 'object' || Array.isArray(data.succMap)) return null;
    const paths = Object.entries(data.succMap);
    return paths.length === 1 && paths[0][0] === name && isAttachmentAssetPath(paths[0][1]) ? paths[0][1] : null;
}

/** Files stay in SiYuan's native assets folder; this function never creates or edits a task. */
export function createTaskAttachmentUploader({post, FormDataClass = globalThis.FormData} = {}) {
    if (typeof post !== 'function') throw new TypeError('缺少思源上传接口');
    return async files => {
        const uploaded = [], failed = [];
        for (const file of Array.from(files || [])) {
            const name = typeof file?.name === 'string' && file.name ? file.name : '未命名附件';
            try {
                if (!file || typeof file.name !== 'string' || !file.name || typeof file.arrayBuffer !== 'function') {
                    throw new Error('请选择本地文件');
                }
                const body = new FormDataClass();
                body.append('assetsDirPath', '/assets/');
                body.append('file[]', file, file.name);
                const response = await post('/api/asset/upload', body);
                const path = response?.code === 0 ? confirmedPath(response.data, file.name) : null;
                if (!path) throw new Error(response?.msg || '思源未确认该附件上传成功，请核查后再试');
                uploaded.push({name: file.name, path});
            } catch (error) {
                failed.push({name, message: error?.message || '附件上传未确认，请核查后再试'});
            }
        }
        return {uploaded, failed};
    };
}
