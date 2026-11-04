import {fetchSyncPost} from 'siyuan';
import {isValidNodeID} from './node-id.js';

const NOTES_PATH = '/思源工作台/笔记';
const CATEGORY = 'custom-workbench-category';
const TAGS = 'custom-workbench-tags';
const defaultPost = (path, body) => fetchSyncPost(path, body, undefined, false);

/** Category/tag attributes are the sole organization source; note Markdown is never rewritten. */
export class WorkbenchNotesRepository {
    constructor(notebookId, {post = defaultPost} = {}) {
        if (!isValidNodeID(notebookId)) throw new Error('请选择有效的笔记本');
        this.notebookId = notebookId;
        this.post = post;
    }

    async list() {
        const rows = [];
        const seen = new Set();
        for (let offset = 0; ; offset += 500) {
            const result = await this.#post('/api/query/sql', {mode: 'readonly', stmt:
                `SELECT id, content, updated FROM blocks WHERE type='d' AND box='${this.notebookId}' AND hpath LIKE '${NOTES_PATH}/%' AND hpath NOT LIKE '${NOTES_PATH}/%/%' ORDER BY updated DESC, id ASC LIMIT 500 OFFSET ${offset}`});
            if (!Array.isArray(result.data)) throw new Error('笔记列表响应无效');
            for (const row of result.data) {
                if (!isValidNodeID(row?.id) || seen.has(row.id)) throw new Error('笔记列表包含无效或重复文档，请刷新重试');
                seen.add(row.id);
                rows.push(row);
            }
            if (result.data.length < 500) break;
        }
        const notes = await mapLimited(rows, 4, async row => {
            const attrs = await this.#attrs(row.id);
            if (!isNote(attrs, row.id)) return null;
            await this.#assertLocation(row.id);
            const note=await this.#read(row, attrs);
            await this.#assertLocation(row.id);
            return note;
        });
        return notes.filter(Boolean);
    }

    async updateMetadata(id, input) {
        if (!isValidNodeID(id)) throw new Error('笔记 ID 无效');
        const metadata = validateNoteMetadata(input);
        await this.#assertLocation(id);
        const attrs = await this.#attrs(id);
        if (!isNote(attrs, id)) throw new Error('文档不是当前工作台笔记');
        // Check corrupt existing metadata before changing it; callers must not overwrite silently.
        readMetadata(attrs);
        const result = await this.#post('/api/query/sql', {mode: 'readonly', stmt:
            `SELECT id, content, updated FROM blocks WHERE type='d' AND box='${this.notebookId}' AND id='${id}' LIMIT 1`});
        const row = result.data?.find?.(item => item.id === id);
        if (!row) throw new Error('当前笔记不存在或尚未索引，请刷新重试');
        const note = await this.#read(row, attrs);
        // Export/read requests may be delayed while a user moves the document.
        await this.#assertLocation(id);
        const freshAttrs = await this.#attrs(id);
        if (!isNote(freshAttrs, id)) throw new Error('笔记标记已更改，未保存分类与标签');
        readMetadata(freshAttrs);
        await this.#post('/api/attr/setBlockAttrs', {id, attrs: {
            [CATEGORY]: metadata.category,
            [TAGS]: JSON.stringify(metadata.tags),
        }});
        return {...note, ...metadata};
    }

    async #read(row, attrs) {
        if (typeof row.content !== 'string') throw new Error('无法读取笔记标题');
        const raw = await this.#post('/api/block/getBlockKramdown', {id: row.id});
        if (raw.data?.id!==row.id||typeof raw.data.kramdown !== 'string') throw new Error(`无法读取笔记正文或身份不匹配：${row.id}`);
        const searchText = removeLeadingFrontmatter(removeMetadataSnapshot(stripNativeIAL(raw.data.kramdown), row.id));
        return {id: row.id, title: row.content, ...readMetadata(attrs), updatedAt: row.updated || '',
            excerpt: searchText.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '').replace(/\s+/g, ' ').trim().slice(0, 160), searchText};
    }

    async #attrs(id) {
        const response = await this.#post('/api/attr/getBlockAttrs', {id});
        if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) throw new Error('无法读取笔记属性');
        return response.data;
    }

    async #assertLocation(id) {
        const response = await this.#post('/api/filetree/getPathByID', {id});
        const location = response.data;
        const segments = typeof location?.path === 'string' ? location.path.split('/').filter(Boolean) : [];
        const [rootID, parentID, leaf] = segments;
        if (location?.notebook !== this.notebookId || segments.length !== 3
            || !isValidNodeID(rootID) || !isValidNodeID(parentID) || leaf !== `${id}.sy`) {
            throw new Error('笔记已移出当前工作台目录，未修改文档');
        }
        const parent = await this.#post('/api/filetree/getPathByID', {id: parentID});
        if (parent.data?.notebook !== this.notebookId || parent.data?.path !== `/${rootID}/${parentID}.sy`) {
            throw new Error('笔记目录位置已更改');
        }
        const path = await this.#post('/api/filetree/getHPathByID', {id: parentID});
        if (path.data !== NOTES_PATH) throw new Error('文档不在工作台笔记目录');
        const folder = await this.#post('/api/block/getBlockKramdown', {id: parentID});
        const marker = `<!-- siyuan-workbench-folder:v1:${this.notebookId}:notes -->`;
        if (folder.data?.id!==parentID||typeof folder.data.kramdown !== 'string' || !folder.data.kramdown.includes(marker)) throw new Error('笔记目录标记不匹配');
    }

    async #post(path, body) {
        const response = await this.post(path, body);
        if (!response || response.code !== 0) throw new Error(response?.msg || `思源接口调用失败：${path}`);
        return response;
    }
}

export function validateNoteMetadata(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => key !== 'category' && key !== 'tags')) throw new Error('笔记分类与标签参数无效');
    if (typeof input.category !== 'string' || input.category.trim().length > 100) throw new Error('分类不能超过 100 个字符');
    if (!Array.isArray(input.tags) || input.tags.length > 20
        || input.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.trim().length > 50)) throw new Error('最多 20 个标签，每个标签为 1–50 个字符');
    return {category: input.category.trim(), tags: [...new Set(input.tags.map(tag => tag.trim()))]};
}

function isNote(attrs, id) {
    return attrs['custom-workbench-type'] === 'note' && attrs['custom-workbench-id'] === id;
}

function readMetadata(attrs) {
    let tags;
    try { tags = attrs[TAGS] === undefined || attrs[TAGS] === '' ? [] : JSON.parse(attrs[TAGS]); }
    catch { throw new Error('笔记标签属性损坏，请在思源文档属性中核查'); }
    return validateNoteMetadata({category: attrs[CATEGORY] ?? '', tags});
}

function removeMetadataSnapshot(markdown, id) {
    // The marker holds the old creation snapshot. Search the live document, not that snapshot.
    const normalized = markdown.replace(/\r\n/g, '\n');
    let last = null;
    for (const match of normalized.matchAll(/^```workbench-note\n([\s\S]*?)\n```[ \t]*(?=\n|$)/gm)) {
        try {
            const snapshot = JSON.parse(match[1]);
            if (snapshot?.type === 'note' && snapshot.id === id) last = match;
        } catch { /* A user's example or malformed block remains searchable. */ }
    }
    return last ? (normalized.slice(0, last.index) + normalized.slice(last.index + last[0].length)).trimEnd() : normalized;
}

function removeLeadingFrontmatter(markdown) {
    // SiYuan export can prepend document metadata. Strip only the first leading
    // YAML-shaped block in this display/search copy; never modify the document.
    return markdown.replace(/^\uFEFF?---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/, (block, yaml) =>
        /^[A-Za-z_][A-Za-z0-9_-]*[ \t]*:/m.test(yaml) ? '' : block);
}

async function mapLimited(items, concurrency, operation) {
    const output = new Array(items.length);
    let next = 0,failed=false;
    await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, async () => {
        while (!failed && next < items.length) {
            const index = next++;
            try{output[index] = await operation(items[index]);}catch(error){failed=true;throw error;}
        }
    }));
    return output;
}

function stripNativeIAL(markdown){
    let fence=null;const lines=[];
    for(const line of markdown.replace(/\r\n?/g,'\n').split('\n')){
        const match=line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if(fence){lines.push(line);if(match&&match[1][0]===fence.char&&match[1].length>=fence.length&&!match[2].trim())fence=null;continue;}
        if(match){fence={char:match[1][0],length:match[1].length};lines.push(line);continue;}
        if(/^\s*\{:\s+id="\d{14}-[a-z0-9]{7}"[^\n]*\}\s*$/.test(line))continue;
        lines.push(line.replace(/\{:\s+id="\d{14}-[a-z0-9]{7}"[^}\n]*\}/g,''));
    }
    return lines.join('\n');
}
