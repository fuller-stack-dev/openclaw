import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

type SessionWriteLockRunner = <T>(run: () => Promise<T> | T) => Promise<T>;

type SessionTranscriptWriteContext = {
  sessionFile: string;
  withSessionWriteLock: SessionWriteLockRunner;
};

const activeSessionTranscriptWriteContext = new AsyncLocalStorage<SessionTranscriptWriteContext>();

export function runWithSessionTranscriptWriteContext<T>(
  params: {
    sessionFile: string;
    withSessionWriteLock: SessionWriteLockRunner;
  },
  run: () => Promise<T> | T,
): Promise<T> | T {
  return activeSessionTranscriptWriteContext.run(
    {
      sessionFile: path.resolve(params.sessionFile),
      withSessionWriteLock: params.withSessionWriteLock,
    },
    run,
  );
}

export async function withActiveSessionTranscriptWriteLock<T>(
  sessionFile: string,
  run: () => Promise<T> | T,
): Promise<T> {
  const context = activeSessionTranscriptWriteContext.getStore();
  if (!context || path.resolve(sessionFile) !== context.sessionFile) {
    return await run();
  }
  return await context.withSessionWriteLock(run);
}
