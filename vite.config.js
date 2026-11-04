import {defineConfig} from 'vite';
import {copyFileSync, mkdirSync, readFileSync, lstatSync} from 'node:fs';
import {resolve, dirname} from 'node:path';

const packageFiles=JSON.parse(readFileSync(new URL('./scripts/package-files.json',import.meta.url),'utf8'));

export default defineConfig({
    plugins: [{
        name: 'copy-plugin-metadata',
        closeBundle() {
            const dist = resolve('dist');
            mkdirSync(dist, {recursive: true});
            for (const file of packageFiles.copied) {
                if(!/^[A-Za-z0-9._/-]+$/.test(file)||file.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('Unsafe package metadata path');
                let source=resolve('.');
                for(const part of file.split('/')){source=resolve(source,part);if(lstatSync(source).isSymbolicLink())throw new Error('Package metadata must not use symbolic links: '+file);}
                const destination=resolve(dist,file);
                mkdirSync(dirname(destination),{recursive:true});
                copyFileSync(source,destination);
            }
        },
    }],
    build: {
        target: 'es2020',
        outDir: 'dist',
        emptyOutDir: true,
        lib: {
            entry: 'src/index.js',
            formats: ['cjs'],
            fileName: () => 'index.js',
        },
        rollupOptions: {
            external: ['siyuan'],
            output: {
                entryFileNames: 'index.js',
                assetFileNames: asset => asset.name?.endsWith('.css') ? 'index.css' : asset.name,
            },
        },
    },
});
