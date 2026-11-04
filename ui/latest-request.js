// Each view owns a gate. Responses can mutate it only while they are current.
export function createLatestRequest() {
  let sequence = 0;
  let disposed = false;
  return {
    async run(load, apply, fail) {
      const request = ++sequence;
      try {
        const value = await load();
        if (disposed || request !== sequence) return false;
        apply(value);
        return true;
      } catch (error) {
        if (disposed || request !== sequence) return false;
        fail(error);
        return true;
      }
    },
    dispose() { disposed = true; sequence += 1; },
  };
}

export function noteRetryState(payload, error) {
  const commitState = error?.commitState || error?.data?.commitState;
  const collision = error?.idCollision === true && commitState === 'none';
  return {
    collision,
    locked: commitState === 'unknown',
    pending: collision ? {} : {id: payload.id, createdAt: payload.createdAt, updatedAt: payload.updatedAt},
  };
}
