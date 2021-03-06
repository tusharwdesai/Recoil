/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * A type that represents a value that may or may not be loaded. It differs from
 * LoadObject in that the `loading` state has a Promise that is meant to resolve
 * when the value is available (but as with LoadObject, an individual Loadable
 * is a value type and is not mutated when the status of a request changes).
 *
 * @emails oncall+recoil
 * @flow strict
 * @format
 */
'use strict';

import type {NodeKey} from '../core/Recoil_Keys';

const gkx = require('../util/Recoil_gkx');
const isPromise = require('../util/Recoil_isPromise');
const nullthrows = require('../util/Recoil_nullthrows');

// TODO Convert Loadable to a Class to allow for runtime type detection.
// Containing static factories of withValue(), withError(), withPromise(), and all()

export type ResolvedLoadablePromiseInfo<+T> = $ReadOnly<{
  __value: T,
  __key?: NodeKey,
}>;

class Canceled {}
const CANCELED: Canceled = new Canceled();

export type LoadablePromise<+T> = Promise<
  ResolvedLoadablePromiseInfo<T> | Canceled,
>;

type Accessors<T> = $ReadOnly<{
  // Attempt to get the value.
  // If there's an error, throw an error.  If it's still loading, throw a Promise
  // This is useful for composing with React Suspense or in a Recoil Selector.
  getValue: () => T,
  toPromise: () => Promise<T>,

  // Convenience accessors
  valueMaybe: () => T | void,
  valueOrThrow: () => T,
  errorMaybe: () => mixed | void,
  errorOrThrow: () => mixed,
  promiseMaybe: () => Promise<T> | void,
  promiseOrThrow: () => Promise<T>,

  is: (Loadable<mixed>) => boolean,

  map: <T, S>(map: (T) => Promise<S> | S) => Loadable<S>,
}>;

export type Loadable<+T> =
  | $ReadOnly<{state: 'hasValue', contents: T, ...Accessors<T>}>
  | $ReadOnly<{state: 'hasError', contents: mixed, ...Accessors<T>}>
  | $ReadOnly<{
      state: 'loading',
      contents: LoadablePromise<T>,
      ...Accessors<T>,
    }>;

type UnwrapLoadables<Loadables> = $TupleMap<Loadables, <T>(Loadable<T>) => T>;

const loadableAccessors = {
  /**
   * if loadable has a value (state === 'hasValue'), return that value.
   * Otherwise, throw the (unwrapped) promise or the error.
   */
  getValue() {
    if (this.state === 'loading' && gkx('recoil_async_selector_refactor')) {
      throw (this.contents: Promise<$FlowFixMe>).then(({__value}) => __value);
    }

    if (this.state !== 'hasValue') {
      throw this.contents;
    }

    return this.contents;
  },

  toPromise(): Promise<$FlowFixMe> {
    return this.state === 'hasValue'
      ? Promise.resolve(this.contents)
      : this.state === 'hasError'
      ? Promise.reject(this.contents)
      : gkx('recoil_async_selector_refactor')
      ? (this.contents: Promise<$FlowFixMe>).then(({__value}) => __value)
      : this.contents;
  },

  valueMaybe() {
    return this.state === 'hasValue' ? this.contents : undefined;
  },

  valueOrThrow() {
    if (this.state !== 'hasValue') {
      const error = new Error(
        `Loadable expected value, but in "${this.state}" state`,
      );
      // V8 keeps closures alive until stack is accessed, this prevents a memory leak
      error.stack;
      throw error;
    }
    return this.contents;
  },

  errorMaybe() {
    return this.state === 'hasError' ? this.contents : undefined;
  },

  errorOrThrow() {
    if (this.state !== 'hasError') {
      const error = new Error(
        `Loadable expected error, but in "${this.state}" state`,
      );
      // V8 keeps closures alive until stack is accessed, this prevents a memory leak
      error.stack;
      throw error;
    }
    return this.contents;
  },

  promiseMaybe(): void | Promise<$FlowFixMe> {
    return this.state === 'loading'
      ? gkx('recoil_async_selector_refactor')
        ? (this.contents: Promise<$FlowFixMe>).then(({__value}) => __value)
        : this.contents
      : undefined;
  },

  promiseOrThrow(): Promise<$FlowFixMe> {
    if (this.state !== 'loading') {
      const error = new Error(
        `Loadable expected promise, but in "${this.state}" state`,
      );
      // V8 keeps closures alive until stack is accessed, this prevents a memory leak
      error.stack;
      throw error;
    }

    return gkx('recoil_async_selector_refactor')
      ? (this.contents: Promise<$FlowFixMe>).then(({__value}) => __value)
      : (this.contents: Promise<$FlowFixMe>);
  },

  is(other: Loadable<mixed>): boolean {
    return other.state === this.state && other.contents === this.contents;
  },

  // TODO Unit tests
  // TODO Convert Loadable to a Class to better support chaining
  //      by returning a Loadable from a map function
  map<T, S>(map: T => LoadablePromise<S> | S): Loadable<S> {
    if (this.state === 'hasError') {
      return this;
    }
    if (this.state === 'hasValue') {
      try {
        const next = map(this.contents);
        // TODO if next instanceof Loadable, then return next
        return isPromise(next)
          ? loadableWithPromise(next)
          : loadableWithValue(next);
      } catch (e) {
        return isPromise(e)
          ? // If we "suspended", then try again.
            // errors and subsequent retries will be handled in 'loading' case
            loadableWithPromise(e.next(() => map(this.contents)))
          : loadableWithError(e);
      }
    }
    if (this.state === 'loading') {
      return loadableWithPromise(
        this.contents
          // TODO if map returns a loadable, then return the value or promise or throw the error
          .then(map)
          .catch(e => {
            if (isPromise(e)) {
              // we were "suspended," try again
              return e.then(() => map(this.contents));
            }
            throw e;
          }),
      );
    }
    const error = new Error('Invalid Loadable state');
    // V8 keeps closures alive until stack is accessed, this prevents a memory leak
    error.stack;
    throw error;
  },
};

function loadableWithValue<T>(value: T): Loadable<T> {
  // Build objects this way since Flow doesn't support disjoint unions for class properties
  return Object.freeze({
    state: 'hasValue',
    contents: value,
    ...loadableAccessors,
  });
}

function loadableWithError<T>(error: mixed): Loadable<T> {
  return Object.freeze({
    state: 'hasError',
    contents: error,
    ...loadableAccessors,
  });
}

function loadableWithPromise<T>(promise: LoadablePromise<T>): Loadable<T> {
  return Object.freeze({
    state: 'loading',
    contents: promise,
    ...loadableAccessors,
  });
}

function loadableLoading<T>(): Loadable<T> {
  return loadableWithPromise(new Promise(() => {}));
}

function loadableAll<Inputs: $ReadOnlyArray<Loadable<mixed>>>(
  inputs: Inputs,
): Loadable<UnwrapLoadables<Inputs>> {
  return inputs.every(i => i.state === 'hasValue')
    ? loadableWithValue(inputs.map(i => i.contents))
    : inputs.some(i => i.state === 'hasError')
    ? loadableWithError(
        nullthrows(
          inputs.find(i => i.state === 'hasError'),
          'Invalid loadable passed to loadableAll',
        ).contents,
      )
    : loadableWithPromise(
        gkx('recoil_async_selector_refactor')
          ? Promise.all(inputs.map(i => i.contents)).then(value => ({
              __value: value,
            }))
          : (Promise.all(inputs.map(i => i.contents)): $FlowFixMe),
      );
}

module.exports = {
  loadableWithValue,
  loadableWithError,
  loadableWithPromise,
  loadableLoading,
  loadableAll,
  Canceled,
  CANCELED,
};
