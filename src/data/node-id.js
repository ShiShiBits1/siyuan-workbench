const NODE_ID_PATTERN = /^\d{14}-[a-z0-9]{7}$/;
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const GENERATED_IDS = new Set();

export function isValidNodeID(id) {
    return typeof id === 'string' && NODE_ID_PATTERN.test(id);
}

export function newNodeID() {
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const cryptoAPI = globalThis.crypto;
    if (!cryptoAPI?.getRandomValues) throw new Error('当前环境不支持安全随机数，无法生成思源文档 ID');
    // Rejection sampling gives all 36 lowercase alphanumeric symbols equal probability.
    let suffix = '';
    while (suffix.length < 7) {
        const bytes = cryptoAPI.getRandomValues(new Uint8Array(16));
        for (const byte of bytes) {
            if (byte >= 252) continue;
            suffix += ID_ALPHABET[byte % ID_ALPHABET.length];
            if (suffix.length === 7) break;
        }
    }
    const id = `${stamp}-${suffix}`;
    if (!isValidNodeID(id)) throw new Error('生成的思源文档 ID 格式无效');
    if (GENERATED_IDS.has(id)) return newNodeID();
    GENERATED_IDS.add(id);
    return id;
}

export function stableNodeID(seed) {
    let hash = 5381;
    for (const char of seed) hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0;
    const suffix = hash.toString(36).padStart(7, '0').slice(-7);
    const timePart = seed.match(/\d{14}/)?.[0] || '20000101000000';
    const id = `${timePart}-${suffix}`;
    if (!isValidNodeID(id)) throw new Error('生成的思源目录 ID 格式无效');
    return id;
}
