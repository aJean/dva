import invariant from 'invariant';
import warning from 'warning';
import { effects as sagaEffects } from 'redux-saga';
import { NAMESPACE_SEP } from './constants';
import prefixType from './prefixType';

// runSaga 时候执行，收集 model 上的所有 effect
export default function getSaga(effects, model, onError, onEffect, opts = {}) {
  return function*() {
    for (const key in effects) {
      if (Object.prototype.hasOwnProperty.call(effects, key)) {
        const watcher = getWatcher(key, effects[key], model, onError, onEffect, opts);
        const task = yield sagaEffects.fork(watcher);
        yield sagaEffects.fork(function*() {
          // 取消 model effect，dispatch({type:${model.namespace}/@@CANCEL_EFFECTS})
          yield sagaEffects.take(`${model.namespace}/@@CANCEL_EFFECTS`);
          yield sagaEffects.cancel(task);
        });
      }
    }
  };
}

/**
 * 给 model 上的每一个 effect 生成 watcher，返回的是一个 saga function，在外部一起执行 runSaga
 */
function getWatcher(key, _effect, model, onError, onEffect, opts) {
  let effect = _effect;
  let type = 'takeEvery';
  let ms;
  let delayMs;

  // 支持不同的 type，effect 传入数组
  if (Array.isArray(_effect)) {
    [effect] = _effect;
    const opts = _effect[1];
    if (opts && opts.type) {
      ({ type } = opts);
      if (type === 'throttle') {
        invariant(opts.ms, 'app.start: opts.ms should be defined if type is throttle');
        ({ ms } = opts);
      }
      if (type === 'poll') {
        invariant(opts.delay, 'app.start: opts.delay should be defined if type is poll');
        ({ delay: delayMs } = opts);
      }
    }
    invariant(
      ['watcher', 'takeEvery', 'takeLatest', 'throttle', 'poll'].indexOf(type) > -1,
      'app.start: effect type should be takeEvery, takeLatest, throttle, poll or watcher',
    );
  }

  function noop() {}

  /**
   * resolve 来自 umi 的 dispatch 返回的是 promise，这块没看但应该是对 store.dispatch 做了封装
   * 把 promise 的 resolve、reject 放到了 action 对象里
   */
  function* sagaWithCatch(...args) {
    const { __dva_resolve: resolve = noop, __dva_reject: reject = noop } =
      args.length > 0 ? args[0] : {};
    try {
      yield sagaEffects.put({ type: `${key}${NAMESPACE_SEP}@@start` });
      // 为 model.effects.fn 注入参数： action 、sagaEffects
      const ret = yield effect(...args.concat(createEffects(model, opts)));
      yield sagaEffects.put({ type: `${key}${NAMESPACE_SEP}@@end` });
      resolve(ret);
    } catch (e) {
      // 可以处理所有 effect 的异常
      onError(e, {
        key,
        effectArgs: args,
      });
      // 是否要触发 promise 的异常，dispatch('XXX').catch()
      if (!e._dontReject) {
        reject(e);
      }
    }
  }

  // 触发 onEffect 钩子，warp effect
  const sagaWithOnEffect = applyOnEffect(onEffect, sagaWithCatch, model, key);

  // 监听 action，默认使用 take every
  switch (type) {
    case 'watcher':
      return sagaWithCatch;
    case 'takeLatest':
      return function*() {
        yield sagaEffects.takeLatest(key, sagaWithOnEffect);
      };
    case 'throttle':
      return function*() {
        yield sagaEffects.throttle(ms, key, sagaWithOnEffect);
      };
    case 'poll':
      return function*() {
        function delay(timeout) {
          return new Promise(resolve => setTimeout(resolve, timeout));
        }
        function* pollSagaWorker(sagaEffects, action) {
          const { call } = sagaEffects;
          while (true) {
            yield call(sagaWithOnEffect, action);
            yield call(delay, delayMs);
          }
        }
        const { call, take, race } = sagaEffects;
        while (true) {
          const action = yield take(`${key}-start`);
          yield race([call(pollSagaWorker, sagaEffects, action), take(`${key}-stop`)]);
        }
      };
    default:
      return function*() {
        // 监听 model.effects.key
        yield sagaEffects.takeEvery(key, sagaWithOnEffect);
      };
  }
}

/**
 * 创建 model.effects 执行时的第2个参数对象，第一个是 action
 * 注意 effect 内部使用 put 不用传递 namespace
 */ 
function createEffects(model, opts) {
  function assertAction(type, name) {
    invariant(type, 'dispatch: action should be a plain Object with type');

    const { namespacePrefixWarning = true } = opts;

    if (namespacePrefixWarning) {
      warning(
        type.indexOf(`${model.namespace}${NAMESPACE_SEP}`) !== 0,
        `[${name}] ${type} should not be prefixed with namespace ${model.namespace}`,
      );
    }
  }
  function put(action) {
    const { type } = action;
    assertAction(type, 'sagaEffects.put');
    // 给 put action 加上 model 的 namespace
    return sagaEffects.put({ ...action, type: prefixType(type, model) });
  }

  // The operator `put` doesn't block waiting the returned promise to resolve.
  // Using `put.resolve` will wait until the promsie resolve/reject before resuming.
  // It will be helpful to organize multi-effects in order,
  // and increase the reusability by seperate the effect in stand-alone pieces.
  // https://github.com/redux-saga/redux-saga/issues/336
  function putResolve(action) {
    const { type } = action;
    assertAction(type, 'sagaEffects.put.resolve');
    return sagaEffects.put.resolve({
      ...action,
      type: prefixType(type, model),
    });
  }
  put.resolve = putResolve;

  function take(type) {
    if (typeof type === 'string') {
      assertAction(type, 'sagaEffects.take');
      return sagaEffects.take(prefixType(type, model));
    } else if (Array.isArray(type)) {
      return sagaEffects.take(
        type.map(t => {
          if (typeof t === 'string') {
            assertAction(t, 'sagaEffects.take');
            return prefixType(t, model);
          }
          return t;
        }),
      );
    } else {
      return sagaEffects.take(type);
    }
  }
  return { ...sagaEffects, put, take };
}

// 洋葱模型 middleware
function applyOnEffect(fns, effect, model, key) {
  for (const fn of fns) {
    effect = fn(effect, sagaEffects, model, key);
  }
  return effect;
}
