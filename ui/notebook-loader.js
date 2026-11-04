export function createSerialWriter(write) {
  let pending = Promise.resolve();
  return value => {
    const result = pending.then(() => write(value));
    pending = result.catch(() => {});
    return result;
  };
}

export function createNotebookLoader({onSelect, persist, read, apply, onError, onDispose = () => {}}) {
  let generation = 0;
  let disposed = false;
  return {
    async load(notebookId) {
      if (disposed) return;
      const request = ++generation;
      const current = () => !disposed && request === generation;
      onSelect(notebookId);
      try {
        await persist(notebookId);
        if (!current()) return;
        const data = await read(notebookId);
        if (!current()) return;
        apply(data, notebookId);
      } catch (error) {
        if (current()) onError(error);
      }
    },
    dispose() {if (disposed) return; disposed = true; generation += 1; onDispose();},
  };
}
