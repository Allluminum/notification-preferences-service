import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from '../../application/ports.js';

/**
 * Logger port implementation that writes through the logger of the current HTTP request
 * (so business events carry the request id), falling back to the root logger outside a request.
 */
export class ContextualLogger implements Logger {
  private readonly storage = new AsyncLocalStorage<Logger>();

  constructor(private readonly root: Logger) {}

  /** Runs `fn` with `logger` bound as the current logger. */
  runWith(logger: Logger, fn: () => void): void {
    this.storage.run(logger, fn);
  }

  private get current(): Logger {
    return this.storage.getStore() ?? this.root;
  }

  info(fields: object, message: string): void {
    this.current.info(fields, message);
  }

  warn(fields: object, message: string): void {
    this.current.warn(fields, message);
  }

  error(fields: object, message: string): void {
    this.current.error(fields, message);
  }
}
