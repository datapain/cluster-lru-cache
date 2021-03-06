import LRU from 'lru-cache';
import cluster from 'cluster';
import { Result, Ok, Err } from 'ts-results';
import hash from 'object-hash';
import { LruCacheAction, LruCacheConfiguration, LruCacheMessageInterface, Maybe } from './types';
import { LruCacheMessage, LruCacheMessageResult } from './messages';

export class LruCache<P, V> {
  private cache: LRU<string, V>;
  private isWorker: boolean;
  private _enabled: boolean;
  private _serviceName: string;
  public get enabled(): boolean {
    return this._enabled;
  }

  private makeMessage<T, M>(opt: LruCacheMessageInterface<T, M>) {
    return LruCacheMessage.of<T, M>({ ...opt, serviceName: this._serviceName });
  }

  private makeMessageResult<T>(id: string, value: T) {
    return LruCacheMessageResult.of<T>(id, value, this._serviceName);
  }

  public init(config: LruCacheConfiguration<string, V>): void {
    this._enabled = config.enabled;
    this.isWorker = cluster.isWorker;
    this._serviceName = config.serviceName || this.constructor.name;

    this.isMaster().andThen((isMaster) => {
      if (isMaster) {
        this.cache = new LRU<string, V>(config);

        for (const id in cluster.workers) {
          cluster.workers[id].on('message', (msg: Maybe<LruCacheMessage<V, P>>) => {
            setImmediate(() => {
              if (LruCacheMessage.isMessage(msg, this._serviceName).ok) {
                switch (msg.action) {
                  case LruCacheAction.GET: {
                    return this.get(msg.payload, msg.id);
                  }
                  case LruCacheAction.HAS: {
                    return this.has(msg.payload, msg.id);
                  }
                  case LruCacheAction.SET: {
                    return this.set(msg.payload, msg.value, msg.id);
                  }
                  case LruCacheAction.GET_BY_HASH: {
                    return this.getByHash(msg.hash, msg.id);
                  }
                  case LruCacheAction.HAS_BY_HASH: {
                    return this.hasByHash(msg.hash, msg.id);
                  }
                  case LruCacheAction.SET_BY_HASH: {
                    return this.setByHash(msg.hash, msg.value, msg.id);
                  }
                  case LruCacheAction.SET_STATUS: {
                    return this.setStatus(Boolean(msg.payload));
                  }
                  case LruCacheAction.RESET: {
                    return this.reset();
                  }
                }
              }
            });
          });
        }
      } else {
        process.on('message', (msg: Maybe<LruCacheMessage<V, P>>) => {
          setImmediate(() => {
            if (LruCacheMessage.isMessage(msg, this._serviceName)) {
              switch (msg.action) {
                case LruCacheAction.SET_STATUS: {
                  this._enabled = Boolean(msg.payload);
                }
              }
            }
          });
        });
      }
      return Ok.EMPTY;
    });
  }

  protected isEnabled(): Result<boolean, Error> {
    return this.isMaster().andThen((isMaster) =>
      isMaster && !this.cache
        ? Err(new Error(`${this.constructor.name} isn't initialized`))
        : this.enabled
        ? Ok(this.enabled)
        : Err(new Error('${this.constructor.name} is disabled')),
    );
  }

  protected isMaster(): Result<boolean, Error> {
    if (typeof this.isWorker === 'undefined') {
      return Err(new Error('Undefined behaviour while checking isMaster or isWorker'));
    }
    return Ok(!this.isWorker);
  }

  public hash(payload: unknown): Result<string, Error> {
    try {
      return Ok(hash(payload));
    } catch (e) {
      return Err(e);
    }
  }

  public async hashAsync(payload: unknown): Promise<Result<string, Error>> {
    try {
      return Ok(hash(payload));
    } catch (e) {
      return Err(e);
    }
  }

  public setStatus(payload: boolean): Result<boolean, Error> {
    return this.isMaster().andThen((isMaster) => {
      if (isMaster) {
        this._enabled = payload;
        return this.response(
          this.makeMessage<never, boolean>({ payload, action: LruCacheAction.SET_STATUS }),
        ).map(() => payload);
      } else {
        return this.request(
          this.makeMessage<never, boolean>({
            payload,
            action: LruCacheAction.SET_STATUS,
          }),
        ).map(() => payload);
      }
    });
  }

  public reset(): Result<void, Error> {
    return this.isMaster().map((isMaster) => {
      if (isMaster) {
        this.cache.reset();
      } else {
        this.request(
          this.makeMessage<never, never>({
            action: LruCacheAction.RESET,
          }),
        ).map(() => Ok.EMPTY);
      }
    });
  }

  private response<RV>(
    result: LruCacheMessageResult<RV> | LruCacheMessage<never, RV>,
  ): Result<LruCacheMessageResult<RV> | LruCacheMessage<never, RV>, Error> {
    try {
      for (const id in cluster.workers) {
        cluster.workers[id].send(result.toJSON());
      }
      return Ok(result);
    } catch (e) {
      return Err(e);
    }
  }

  private request<V, P>(message: LruCacheMessage<V, P>): Result<LruCacheMessage<V, P>, Error> {
    try {
      process.send(message.toJSON());
      return Ok(message);
    } catch (e) {
      return Err(e);
    }
  }

  private async fold<FV>(
    message: LruCacheMessageInterface<V, P>,
    id?: string,
  ): Promise<Result<Maybe<FV>, Error>> {
    return this.isEnabled()
      .andThen(() => this.isMaster())
      .map((isMaster) => {
        if (isMaster) {
          return (message.hash ? Ok(message.hash) : this.hash(message.payload))
            .andThen((hash) => Ok(this.cache[message.action.substr(0, 3)](hash, message.value)))
            .andThen((value) => this.response(this.makeMessageResult<FV>(id, value)))
            .map((response) => response.value);
        } else {
          return new Promise<Result<FV, Error>>((resolve, reject) => {
            this.request(this.makeMessage<V, P>(message))
              .map((message) => {
                const returnResponse = (msg: Maybe<LruCacheMessageResult<FV>>): void => {
                  if (
                    LruCacheMessageResult.isMessageResult(msg, this._serviceName) &&
                    msg?.id === message.id
                  ) {
                    process.removeListener('message', returnResponse);
                    resolve(Ok(msg.value));
                  }
                };
                process.on('message', returnResponse);
              })
              .mapErr((error) => reject(Err(error)));
          });
        }
      })
      .unwrap();
  }

  public async get(payload: P, id?: string): Promise<Result<Maybe<V>, Error>> {
    return this.fold({ payload, action: LruCacheAction.GET }, id);
  }

  public async set(payload: P, value: V, id?: string): Promise<Result<boolean, Error>> {
    return this.fold<boolean>({ payload, value, action: LruCacheAction.SET }, id);
  }

  public async has(payload: P, id?: string): Promise<Result<boolean, Error>> {
    return this.fold<boolean>({ payload, action: LruCacheAction.HAS }, id);
  }

  public async getByHash(hash: string, id?: string): Promise<Result<Maybe<V>, Error>> {
    return this.fold({ hash, action: LruCacheAction.GET_BY_HASH }, id);
  }

  public async setByHash(hash: string, value: V, id?: string): Promise<Result<boolean, Error>> {
    return this.fold<boolean>({ hash, value, action: LruCacheAction.SET_BY_HASH }, id);
  }

  public async hasByHash(hash: string, id?: string): Promise<Result<boolean, Error>> {
    return this.fold<boolean>({ hash, action: LruCacheAction.HAS_BY_HASH }, id);
  }
}
