// One request at a time. An invalidation during a request always causes a later
// read, and failures retain dirty state even when no further events arrive.
export function refreshQueue(
  read: () => Promise<void>,
  error: (e: unknown) => void,
  retryMs = 1500,
) {
  let running = false,
    dirty = false,
    stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      while (dirty && !stopped) {
        dirty = false;
        try {
          await read();
        } catch (e) {
          if (!stopped) {
            dirty = true;
            error(e);
            timer = setTimeout(() => {
              timer = undefined;
              void run();
            }, retryMs);
          }
          break;
        }
      }
    } finally {
      running = false;
    }
  };
  return {
    invalidate() {
      dirty = true;
      if (!timer) void run();
    },
    close() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
