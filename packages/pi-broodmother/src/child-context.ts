import { AsyncLocalStorage } from "node:async_hooks";

const childSessionContext = new AsyncLocalStorage<boolean>();

export function inChildSessionContext(): boolean {
  return childSessionContext.getStore() === true;
}

export function runInChildSessionContext<A>(run: () => Promise<A>): Promise<A> {
  return childSessionContext.run(true, run);
}
