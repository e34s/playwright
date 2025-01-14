/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { EventEmitter } from 'events';
import * as channels from '../protocol/channels';
import { serializeError } from '../protocol/serializers';
import { createScheme, Validator, ValidationError } from '../protocol/validator';
import { assert, createGuid, debugAssert, isUnderTest, monotonicTime } from '../utils/utils';
import { tOptional } from '../protocol/validatorPrimitives';
import { kBrowserOrContextClosedError } from '../utils/errors';
import { CallMetadata, SdkObject } from '../server/instrumentation';
import { StackFrame } from '../common/types';
import { rewriteErrorMessage } from '../utils/stackTrace';

export const dispatcherSymbol = Symbol('dispatcher');

export function lookupDispatcher<DispatcherType>(object: any): DispatcherType {
  const result = object[dispatcherSymbol];
  debugAssert(result);
  return result;
}

export function existingDispatcher<DispatcherType>(object: any): DispatcherType {
  return object[dispatcherSymbol];
}

export function lookupNullableDispatcher<DispatcherType>(object: any | null): DispatcherType | undefined {
  return object ? lookupDispatcher(object) : undefined;
}

export class Dispatcher<Type, Initializer> extends EventEmitter implements channels.Channel {
  private _connection: DispatcherConnection;
  private _isScope: boolean;
  // Parent is always "isScope".
  private _parent: Dispatcher<any, any> | undefined;
  // Only "isScope" channel owners have registered dispatchers inside.
  private _dispatchers = new Map<string, Dispatcher<any, any>>();
  private _disposed = false;

  readonly _guid: string;
  readonly _type: string;
  readonly _scope: Dispatcher<any, any>;
  _object: Type;

  constructor(parent: Dispatcher<any, any> | DispatcherConnection, object: Type, type: string, initializer: Initializer, isScope?: boolean, guid = type + '@' + createGuid()) {
    super();

    this._connection = parent instanceof DispatcherConnection ? parent : parent._connection;
    this._isScope = !!isScope;
    this._parent = parent instanceof DispatcherConnection ? undefined : parent;
    this._scope = isScope ? this : this._parent!;

    assert(!this._connection._dispatchers.has(guid));
    this._connection._dispatchers.set(guid, this);
    if (this._parent) {
      assert(!this._parent._dispatchers.has(guid));
      this._parent._dispatchers.set(guid, this);
    }

    this._type = type;
    this._guid = guid;
    this._object = object;

    (object as any)[dispatcherSymbol] = this;
    if (this._parent)
      this._connection.sendMessageToClient(this._parent._guid, '__create__', { type, initializer, guid });
  }

  _dispatchEvent(method: string, params: Dispatcher<any, any> | any = {}) {
    if (this._disposed) {
      if (isUnderTest())
        throw new Error(`${this._guid} is sending "${method}" event after being disposed`);
      // Just ignore this event outside of tests.
      return;
    }
    this._connection.sendMessageToClient(this._guid, method, params);
  }

  _dispose() {
    assert(!this._disposed);
    this._disposed = true;

    // Clean up from parent and connection.
    if (this._parent)
      this._parent._dispatchers.delete(this._guid);
    this._connection._dispatchers.delete(this._guid);

    // Dispose all children.
    for (const dispatcher of [...this._dispatchers.values()])
      dispatcher._dispose();
    this._dispatchers.clear();

    if (this._isScope)
      this._connection.sendMessageToClient(this._guid, '__dispose__', {});
  }

  _debugScopeState(): any {
    return {
      _guid: this._guid,
      objects: Array.from(this._dispatchers.values()).map(o => o._debugScopeState()),
    };
  }

  async waitForEventInfo(): Promise<void> {
    // Instrumentation takes care of this.
  }
}

export type DispatcherScope = Dispatcher<any, any>;
class Root extends Dispatcher<{}, {}> {
  constructor(connection: DispatcherConnection) {
    super(connection, {}, '', {}, true, '');
  }
}

export class DispatcherConnection {
  readonly _dispatchers = new Map<string, Dispatcher<any, any>>();
  private _rootDispatcher: Root;
  onmessage = (message: object) => {};
  private _validateParams: (type: string, method: string, params: any) => any;
  private _validateMetadata: (metadata: any) => { stack?: StackFrame[] };
  private _waitOperations = new Map<string, CallMetadata>();

  sendMessageToClient(guid: string, method: string, params: any) {
    this.onmessage({ guid, method, params: this._replaceDispatchersWithGuids(params) });
  }

  constructor() {
    this._rootDispatcher = new Root(this);

    const tChannel = (name: string): Validator => {
      return (arg: any, path: string) => {
        if (arg && typeof arg === 'object' && typeof arg.guid === 'string') {
          const guid = arg.guid;
          const dispatcher = this._dispatchers.get(guid);
          if (!dispatcher)
            throw new ValidationError(`${path}: no object with guid ${guid}`);
          if (name !== '*' && dispatcher._type !== name)
            throw new ValidationError(`${path}: object with guid ${guid} has type ${dispatcher._type}, expected ${name}`);
          return dispatcher;
        }
        throw new ValidationError(`${path}: expected ${name}`);
      };
    };
    const scheme = createScheme(tChannel);
    this._validateParams = (type: string, method: string, params: any): any => {
      if (method === 'waitForEventInfo')
        return tOptional(scheme['WaitForEventInfo'])(params.info, '');
      const name = type + method[0].toUpperCase() + method.substring(1) + 'Params';
      if (!scheme[name])
        throw new ValidationError(`Unknown scheme for ${type}.${method}`);
      return scheme[name](params, '');
    };
    this._validateMetadata = (metadata: any): any => {
      return tOptional(scheme['Metadata'])(metadata, '');
    };
  }

  rootDispatcher(): Dispatcher<any, any> {
    return this._rootDispatcher;
  }

  async dispatch(message: object) {
    const { id, guid, method, params, metadata } = message as any;
    const dispatcher = this._dispatchers.get(guid);
    if (!dispatcher) {
      this.onmessage({ id, error: serializeError(new Error(kBrowserOrContextClosedError)) });
      return;
    }
    if (method === 'debugScopeState') {
      this.onmessage({ id, result: this._rootDispatcher._debugScopeState() });
      return;
    }

    let validParams: any;
    let validMetadata: channels.Metadata;
    try {
      validParams = this._validateParams(dispatcher._type, method, params);
      validMetadata = this._validateMetadata(metadata);
      if (typeof (dispatcher as any)[method] !== 'function')
        throw new Error(`Mismatching dispatcher: "${dispatcher._type}" does not implement "${method}"`);
    } catch (e) {
      this.onmessage({ id, error: serializeError(e) });
      return;
    }

    const sdkObject = dispatcher._object instanceof SdkObject ? dispatcher._object : undefined;
    let callMetadata: CallMetadata = {
      id,
      ...validMetadata,
      pageId: sdkObject?.attribution.page?.uniqueId,
      frameId: sdkObject?.attribution.frame?.uniqueId,
      startTime: monotonicTime(),
      endTime: 0,
      type: dispatcher._type,
      method,
      params: params || {},
      log: [],
    };

    try {
      if (sdkObject) {
        // Process logs for waitForNavigation/waitForLoadState
        if (params?.info?.waitId) {
          const info = params.info;
          switch (info.phase) {
            case 'before':
              callMetadata.apiName = info.apiName;
              callMetadata.stack = info.stack;
              this._waitOperations.set(info.waitId, callMetadata);
              break;
            case 'log':
              const originalMetadata = this._waitOperations.get(info.waitId)!;
              originalMetadata.log.push(info.message);
              sdkObject.instrumentation.onCallLog('api', info.message, sdkObject, originalMetadata);
              // Fall through.
            case 'after':
              return;
          }
        }
        await sdkObject.instrumentation.onBeforeCall(sdkObject, callMetadata);
      }
      const result = await (dispatcher as any)[method](validParams, callMetadata);
      this.onmessage({ id, result: this._replaceDispatchersWithGuids(result) });
    } catch (e) {
      // Dispatching error
      callMetadata.error = e.message;
      if (callMetadata.log.length)
        rewriteErrorMessage(e, e.message + formatLogRecording(callMetadata.log) + kLoggingNote);
      this.onmessage({ id, error: serializeError(e) });
    } finally {
      callMetadata.endTime = monotonicTime();
      if (sdkObject) {
        // Process logs for waitForNavigation/waitForLoadState
        if (params?.info?.waitId) {
          const info = params.info;
          switch (info.phase) {
            case 'before':
              callMetadata.endTime = 0;
              // Fall through.
            case 'log':
              return;
            case 'after':
              const originalMetadata = this._waitOperations.get(info.waitId)!;
              originalMetadata.endTime = callMetadata.endTime;
              originalMetadata.error = info.error;
              this._waitOperations.delete(info.waitId);
              callMetadata = originalMetadata;
              break;
          }
        }
        await sdkObject.instrumentation.onAfterCall(sdkObject, callMetadata);
      }
    }
  }

  private _replaceDispatchersWithGuids(payload: any): any {
    if (!payload)
      return payload;
    if (payload instanceof Dispatcher)
      return { guid: payload._guid };
    if (Array.isArray(payload))
      return payload.map(p => this._replaceDispatchersWithGuids(p));
    if (typeof payload === 'object') {
      const result: any = {};
      for (const key of Object.keys(payload))
        result[key] = this._replaceDispatchersWithGuids(payload[key]);
      return result;
    }
    return payload;
  }
}

const kLoggingNote = `\nNote: use DEBUG=pw:api environment variable to capture Playwright logs.`;

function formatLogRecording(log: string[]): string {
  if (!log.length)
    return '';
  const header = ` logs `;
  const headerLength = 60;
  const leftLength = (headerLength - header.length) / 2;
  const rightLength = headerLength - header.length - leftLength;
  return `\n${'='.repeat(leftLength)}${header}${'='.repeat(rightLength)}\n${log.join('\n')}\n${'='.repeat(headerLength)}`;
}
