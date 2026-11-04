import {defineConfig} from 'vite';

export default defineConfig({
    build: {
        target: 'es2020',
        outDir: 'dist',
        emptyOutDir: false,
        lib: {
            entry: 'src/kernel/index.js',
            formats: ['es'],
            fileName: () => 'kernel.js',
        },
        rollupOptions: {
            output: {
                entryFileNames: 'kernel.js',
            },
        },
    },
});
