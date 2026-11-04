/* GERADO por scripts/legacy-build/build.js a partir de app.js — não edite à mão.
 * ES5 para Safari 9 / iOS 9 (iPad 2). Regenerar: cd scripts/legacy-build && npm run build */
/*
 * Prelúdio ES5 do app.legacy.js: polyfills mínimos para o Safari 9 (iPad 2, iOS 9.3) e um shim
 * que traduz eventos de toque em Pointer Events, que o deck usa em todas as teclas e no deslize.
 * Só entra no bundle legado; o app.js moderno nunca passa por aqui.
 */
(function () {
    'use strict';

    // fetch (Safari 10.1+): o deck só usa res.ok, res.status e res.text()
    if (typeof window.fetch !== 'function') {
        window.fetch = function (url, opts) {
            opts = opts || {};
            return new Promise(function (resolve, reject) {
                var xhr = new XMLHttpRequest();
                xhr.open(opts.method || 'GET', url, true);
                var headers = opts.headers || {};
                Object.keys(headers).forEach(function (k) { xhr.setRequestHeader(k, headers[k]); });
                xhr.onload = function () {
                    var body = xhr.responseText || '';
                    resolve({
                        ok: xhr.status >= 200 && xhr.status < 300,
                        status: xhr.status,
                        text: function () { return Promise.resolve(body); },
                        json: function () { try { return Promise.resolve(JSON.parse(body)); } catch (e) { return Promise.reject(e); } }
                    });
                };
                xhr.onerror = function () { reject(new TypeError('Falha de rede')); };
                xhr.ontimeout = function () { reject(new TypeError('Tempo esgotado')); };
                xhr.send(opts.body === undefined ? null : opts.body);
            });
        };
    }

    // NodeList.forEach (Safari 10+)
    if (window.NodeList && !NodeList.prototype.forEach) NodeList.prototype.forEach = Array.prototype.forEach;

    // NodeList/HTMLCollection/DOMTokenList iteráveis (Safari 10+): o deck faz for...of e [...lista] sobre
    // querySelectorAll; sem isto o helper do Babel lança "Invalid attempt to iterate non-iterable instance"
    if (typeof Symbol === 'function' && Symbol.iterator && Array.prototype[Symbol.iterator]) {
        [window.NodeList, window.HTMLCollection, window.DOMTokenList].forEach(function (C) {
            if (C && C.prototype && !C.prototype[Symbol.iterator]) C.prototype[Symbol.iterator] = Array.prototype[Symbol.iterator];
        });
    }

    // Element.matches / closest
    var ep = window.Element && Element.prototype;
    if (ep) {
        if (!ep.matches) ep.matches = ep.webkitMatchesSelector || ep.msMatchesSelector;
        if (!ep.closest) {
            ep.closest = function (sel) {
                var el = this;
                while (el && el.nodeType === 1) {
                    if (el.matches(sel)) return el;
                    el = el.parentElement;
                }
                return null;
            };
        }
        if (!ep.remove) ep.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
    }

    // Pointer Events (Safari 13+) a partir de toques. O alvo do pointerdown fica "capturado" para o
    // identificador do toque, como o navegador faz com toques reais; preventDefault no evento
    // sintético é repassado ao evento de toque (bloqueia rolagem e o click emulado).
    if (!window.PointerEvent && 'ontouchstart' in window) {
        // Captura e não passivo: o Chrome trata touchstart/touchmove no document como passivos e ignoraria
        // o preventDefault; em navegadores sem o objeto de opções ele vira `true` (captura), que é o que importa
        var LISTEN = { capture: true, passive: false };
        var captured = {};
        var primaryId = null;

        // Expressões, não declarações: o Safari 9 rejeita declaração de função dentro de bloco em strict mode
        var fire = function (type, touch, source, el, pressed) {
            if (!el) return;
            var ev = document.createEvent('Event');
            ev.initEvent(type, true, type !== 'pointercancel');
            ev.pointerId = touch.identifier + 2; // 1 é o mouse
            ev.pointerType = 'touch';
            ev.isPrimary = touch.identifier === primaryId;
            ev.clientX = touch.clientX;
            ev.clientY = touch.clientY;
            ev.pageX = touch.pageX;
            ev.pageY = touch.pageY;
            ev.screenX = touch.screenX;
            ev.screenY = touch.screenY;
            ev.button = type === 'pointermove' ? -1 : 0;
            ev.buttons = pressed ? 1 : 0;
            ev.pressure = pressed ? 0.5 : 0;
            ev.width = 1;
            ev.height = 1;
            el.dispatchEvent(ev);
            // Só o pointermove cancelado bloqueia o toque (rolagem durante o arraste do fader). Cancelar o
            // touchstart suprimiria o click que os botões esperam; nos Pointer Events reais isso não acontece.
            if (type === 'pointermove' && ev.defaultPrevented && source.cancelable) source.preventDefault();
        };

        var each = function (e, fn) {
            var list = e.changedTouches;
            for (var i = 0; i < list.length; i++) fn(list[i]);
        };

        document.addEventListener('touchstart', function (e) {
            each(e, function (t) {
                if (primaryId === null) primaryId = t.identifier;
                var el = t.target && t.target.nodeType === 1 ? t.target : (t.target && t.target.parentElement);
                captured[t.identifier] = el;
                fire('pointerdown', t, e, el, true);
            });
        }, LISTEN);

        document.addEventListener('touchmove', function (e) {
            each(e, function (t) { fire('pointermove', t, e, captured[t.identifier] || t.target, true); });
        }, LISTEN);

        var release = function (type) {
            return function (e) {
                each(e, function (t) {
                    fire(type, t, e, captured[t.identifier] || t.target, false);
                    delete captured[t.identifier];
                    if (t.identifier === primaryId) primaryId = null;
                });
            };
        };
        document.addEventListener('touchend', release('pointerup'), LISTEN);
        document.addEventListener('touchcancel', release('pointercancel'), LISTEN);
    }
})();

/**
 * Copyright (c) 2014-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

var runtime = (function (exports) {
  "use strict";

  var Op = Object.prototype;
  var hasOwn = Op.hasOwnProperty;
  var defineProperty = Object.defineProperty || function (obj, key, desc) { obj[key] = desc.value; };
  var undefined; // More compressible than void 0.
  var $Symbol = typeof Symbol === "function" ? Symbol : {};
  var iteratorSymbol = $Symbol.iterator || "@@iterator";
  var asyncIteratorSymbol = $Symbol.asyncIterator || "@@asyncIterator";
  var toStringTagSymbol = $Symbol.toStringTag || "@@toStringTag";

  function define(obj, key, value) {
    Object.defineProperty(obj, key, {
      value: value,
      enumerable: true,
      configurable: true,
      writable: true
    });
    return obj[key];
  }
  try {
    // IE 8 has a broken Object.defineProperty that only works on DOM objects.
    define({}, "");
  } catch (err) {
    define = function(obj, key, value) {
      return obj[key] = value;
    };
  }

  function wrap(innerFn, outerFn, self, tryLocsList) {
    // If outerFn provided and outerFn.prototype is a Generator, then outerFn.prototype instanceof Generator.
    var protoGenerator = outerFn && outerFn.prototype instanceof Generator ? outerFn : Generator;
    var generator = Object.create(protoGenerator.prototype);
    var context = new Context(tryLocsList || []);

    // The ._invoke method unifies the implementations of the .next,
    // .throw, and .return methods.
    defineProperty(generator, "_invoke", { value: makeInvokeMethod(innerFn, self, context) });

    return generator;
  }
  exports.wrap = wrap;

  // Try/catch helper to minimize deoptimizations. Returns a completion
  // record like context.tryEntries[i].completion. This interface could
  // have been (and was previously) designed to take a closure to be
  // invoked without arguments, but in all the cases we care about we
  // already have an existing method we want to call, so there's no need
  // to create a new function object. We can even get away with assuming
  // the method takes exactly one argument, since that happens to be true
  // in every case, so we don't have to touch the arguments object. The
  // only additional allocation required is the completion record, which
  // has a stable shape and so hopefully should be cheap to allocate.
  function tryCatch(fn, obj, arg) {
    try {
      return { type: "normal", arg: fn.call(obj, arg) };
    } catch (err) {
      return { type: "throw", arg: err };
    }
  }

  var GenStateSuspendedStart = "suspendedStart";
  var GenStateSuspendedYield = "suspendedYield";
  var GenStateExecuting = "executing";
  var GenStateCompleted = "completed";

  // Returning this object from the innerFn has the same effect as
  // breaking out of the dispatch switch statement.
  var ContinueSentinel = {};

  // Dummy constructor functions that we use as the .constructor and
  // .constructor.prototype properties for functions that return Generator
  // objects. For full spec compliance, you may wish to configure your
  // minifier not to mangle the names of these two functions.
  function Generator() {}
  function GeneratorFunction() {}
  function GeneratorFunctionPrototype() {}

  // This is a polyfill for %IteratorPrototype% for environments that
  // don't natively support it.
  var IteratorPrototype = {};
  define(IteratorPrototype, iteratorSymbol, function () {
    return this;
  });

  var getProto = Object.getPrototypeOf;
  var NativeIteratorPrototype = getProto && getProto(getProto(values([])));
  if (NativeIteratorPrototype &&
      NativeIteratorPrototype !== Op &&
      hasOwn.call(NativeIteratorPrototype, iteratorSymbol)) {
    // This environment has a native %IteratorPrototype%; use it instead
    // of the polyfill.
    IteratorPrototype = NativeIteratorPrototype;
  }

  var Gp = GeneratorFunctionPrototype.prototype =
    Generator.prototype = Object.create(IteratorPrototype);
  GeneratorFunction.prototype = GeneratorFunctionPrototype;
  defineProperty(Gp, "constructor", { value: GeneratorFunctionPrototype, configurable: true });
  defineProperty(
    GeneratorFunctionPrototype,
    "constructor",
    { value: GeneratorFunction, configurable: true }
  );
  GeneratorFunction.displayName = define(
    GeneratorFunctionPrototype,
    toStringTagSymbol,
    "GeneratorFunction"
  );

  // Helper for defining the .next, .throw, and .return methods of the
  // Iterator interface in terms of a single ._invoke method.
  function defineIteratorMethods(prototype) {
    ["next", "throw", "return"].forEach(function(method) {
      define(prototype, method, function(arg) {
        return this._invoke(method, arg);
      });
    });
  }

  exports.isGeneratorFunction = function(genFun) {
    var ctor = typeof genFun === "function" && genFun.constructor;
    return ctor
      ? ctor === GeneratorFunction ||
        // For the native GeneratorFunction constructor, the best we can
        // do is to check its .name property.
        (ctor.displayName || ctor.name) === "GeneratorFunction"
      : false;
  };

  exports.mark = function(genFun) {
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(genFun, GeneratorFunctionPrototype);
    } else {
      genFun.__proto__ = GeneratorFunctionPrototype;
      define(genFun, toStringTagSymbol, "GeneratorFunction");
    }
    genFun.prototype = Object.create(Gp);
    return genFun;
  };

  // Within the body of any async function, `await x` is transformed to
  // `yield regeneratorRuntime.awrap(x)`, so that the runtime can test
  // `hasOwn.call(value, "__await")` to determine if the yielded value is
  // meant to be awaited.
  exports.awrap = function(arg) {
    return { __await: arg };
  };

  function AsyncIterator(generator, PromiseImpl) {
    function invoke(method, arg, resolve, reject) {
      var record = tryCatch(generator[method], generator, arg);
      if (record.type === "throw") {
        reject(record.arg);
      } else {
        var result = record.arg;
        var value = result.value;
        if (value &&
            typeof value === "object" &&
            hasOwn.call(value, "__await")) {
          return PromiseImpl.resolve(value.__await).then(function(value) {
            invoke("next", value, resolve, reject);
          }, function(err) {
            invoke("throw", err, resolve, reject);
          });
        }

        return PromiseImpl.resolve(value).then(function(unwrapped) {
          // When a yielded Promise is resolved, its final value becomes
          // the .value of the Promise<{value,done}> result for the
          // current iteration.
          result.value = unwrapped;
          resolve(result);
        }, function(error) {
          // If a rejected Promise was yielded, throw the rejection back
          // into the async generator function so it can be handled there.
          return invoke("throw", error, resolve, reject);
        });
      }
    }

    var previousPromise;

    function enqueue(method, arg) {
      function callInvokeWithMethodAndArg() {
        return new PromiseImpl(function(resolve, reject) {
          invoke(method, arg, resolve, reject);
        });
      }

      return previousPromise =
        // If enqueue has been called before, then we want to wait until
        // all previous Promises have been resolved before calling invoke,
        // so that results are always delivered in the correct order. If
        // enqueue has not been called before, then it is important to
        // call invoke immediately, without waiting on a callback to fire,
        // so that the async generator function has the opportunity to do
        // any necessary setup in a predictable way. This predictability
        // is why the Promise constructor synchronously invokes its
        // executor callback, and why async functions synchronously
        // execute code before the first await. Since we implement simple
        // async functions in terms of async generators, it is especially
        // important to get this right, even though it requires care.
        previousPromise ? previousPromise.then(
          callInvokeWithMethodAndArg,
          // Avoid propagating failures to Promises returned by later
          // invocations of the iterator.
          callInvokeWithMethodAndArg
        ) : callInvokeWithMethodAndArg();
    }

    // Define the unified helper method that is used to implement .next,
    // .throw, and .return (see defineIteratorMethods).
    defineProperty(this, "_invoke", { value: enqueue });
  }

  defineIteratorMethods(AsyncIterator.prototype);
  define(AsyncIterator.prototype, asyncIteratorSymbol, function () {
    return this;
  });
  exports.AsyncIterator = AsyncIterator;

  // Note that simple async functions are implemented on top of
  // AsyncIterator objects; they just return a Promise for the value of
  // the final result produced by the iterator.
  exports.async = function(innerFn, outerFn, self, tryLocsList, PromiseImpl) {
    if (PromiseImpl === void 0) PromiseImpl = Promise;

    var iter = new AsyncIterator(
      wrap(innerFn, outerFn, self, tryLocsList),
      PromiseImpl
    );

    return exports.isGeneratorFunction(outerFn)
      ? iter // If outerFn is a generator, return the full iterator.
      : iter.next().then(function(result) {
          return result.done ? result.value : iter.next();
        });
  };

  function makeInvokeMethod(innerFn, self, context) {
    var state = GenStateSuspendedStart;

    return function invoke(method, arg) {
      if (state === GenStateExecuting) {
        throw new Error("Generator is already running");
      }

      if (state === GenStateCompleted) {
        if (method === "throw") {
          throw arg;
        }

        // Be forgiving, per GeneratorResume behavior specified since ES2015:
        // ES2015 spec, step 3: https://262.ecma-international.org/6.0/#sec-generatorresume
        // Latest spec, step 2: https://tc39.es/ecma262/#sec-generatorresume
        return doneResult();
      }

      context.method = method;
      context.arg = arg;

      while (true) {
        var delegate = context.delegate;
        if (delegate) {
          var delegateResult = maybeInvokeDelegate(delegate, context);
          if (delegateResult) {
            if (delegateResult === ContinueSentinel) continue;
            return delegateResult;
          }
        }

        if (context.method === "next") {
          // Setting context._sent for legacy support of Babel's
          // function.sent implementation.
          context.sent = context._sent = context.arg;

        } else if (context.method === "throw") {
          if (state === GenStateSuspendedStart) {
            state = GenStateCompleted;
            throw context.arg;
          }

          context.dispatchException(context.arg);

        } else if (context.method === "return") {
          context.abrupt("return", context.arg);
        }

        state = GenStateExecuting;

        var record = tryCatch(innerFn, self, context);
        if (record.type === "normal") {
          // If an exception is thrown from innerFn, we leave state ===
          // GenStateExecuting and loop back for another invocation.
          state = context.done
            ? GenStateCompleted
            : GenStateSuspendedYield;

          if (record.arg === ContinueSentinel) {
            continue;
          }

          return {
            value: record.arg,
            done: context.done
          };

        } else if (record.type === "throw") {
          state = GenStateCompleted;
          // Dispatch the exception by looping back around to the
          // context.dispatchException(context.arg) call above.
          context.method = "throw";
          context.arg = record.arg;
        }
      }
    };
  }

  // Call delegate.iterator[context.method](context.arg) and handle the
  // result, either by returning a { value, done } result from the
  // delegate iterator, or by modifying context.method and context.arg,
  // setting context.delegate to null, and returning the ContinueSentinel.
  function maybeInvokeDelegate(delegate, context) {
    var methodName = context.method;
    var method = delegate.iterator[methodName];
    if (method === undefined) {
      // A .throw or .return when the delegate iterator has no .throw
      // method, or a missing .next method, always terminate the
      // yield* loop.
      context.delegate = null;

      // Note: ["return"] must be used for ES3 parsing compatibility.
      if (methodName === "throw" && delegate.iterator["return"]) {
        // If the delegate iterator has a return method, give it a
        // chance to clean up.
        context.method = "return";
        context.arg = undefined;
        maybeInvokeDelegate(delegate, context);

        if (context.method === "throw") {
          // If maybeInvokeDelegate(context) changed context.method from
          // "return" to "throw", let that override the TypeError below.
          return ContinueSentinel;
        }
      }
      if (methodName !== "return") {
        context.method = "throw";
        context.arg = new TypeError(
          "The iterator does not provide a '" + methodName + "' method");
      }

      return ContinueSentinel;
    }

    var record = tryCatch(method, delegate.iterator, context.arg);

    if (record.type === "throw") {
      context.method = "throw";
      context.arg = record.arg;
      context.delegate = null;
      return ContinueSentinel;
    }

    var info = record.arg;

    if (! info) {
      context.method = "throw";
      context.arg = new TypeError("iterator result is not an object");
      context.delegate = null;
      return ContinueSentinel;
    }

    if (info.done) {
      // Assign the result of the finished delegate to the temporary
      // variable specified by delegate.resultName (see delegateYield).
      context[delegate.resultName] = info.value;

      // Resume execution at the desired location (see delegateYield).
      context.next = delegate.nextLoc;

      // If context.method was "throw" but the delegate handled the
      // exception, let the outer generator proceed normally. If
      // context.method was "next", forget context.arg since it has been
      // "consumed" by the delegate iterator. If context.method was
      // "return", allow the original .return call to continue in the
      // outer generator.
      if (context.method !== "return") {
        context.method = "next";
        context.arg = undefined;
      }

    } else {
      // Re-yield the result returned by the delegate method.
      return info;
    }

    // The delegate iterator is finished, so forget it and continue with
    // the outer generator.
    context.delegate = null;
    return ContinueSentinel;
  }

  // Define Generator.prototype.{next,throw,return} in terms of the
  // unified ._invoke helper method.
  defineIteratorMethods(Gp);

  define(Gp, toStringTagSymbol, "Generator");

  // A Generator should always return itself as the iterator object when the
  // @@iterator function is called on it. Some browsers' implementations of the
  // iterator prototype chain incorrectly implement this, causing the Generator
  // object to not be returned from this call. This ensures that doesn't happen.
  // See https://github.com/facebook/regenerator/issues/274 for more details.
  define(Gp, iteratorSymbol, function() {
    return this;
  });

  define(Gp, "toString", function() {
    return "[object Generator]";
  });

  function pushTryEntry(locs) {
    var entry = { tryLoc: locs[0] };

    if (1 in locs) {
      entry.catchLoc = locs[1];
    }

    if (2 in locs) {
      entry.finallyLoc = locs[2];
      entry.afterLoc = locs[3];
    }

    this.tryEntries.push(entry);
  }

  function resetTryEntry(entry) {
    var record = entry.completion || {};
    record.type = "normal";
    delete record.arg;
    entry.completion = record;
  }

  function Context(tryLocsList) {
    // The root entry object (effectively a try statement without a catch
    // or a finally block) gives us a place to store values thrown from
    // locations where there is no enclosing try statement.
    this.tryEntries = [{ tryLoc: "root" }];
    tryLocsList.forEach(pushTryEntry, this);
    this.reset(true);
  }

  exports.keys = function(val) {
    var object = Object(val);
    var keys = [];
    for (var key in object) {
      keys.push(key);
    }
    keys.reverse();

    // Rather than returning an object with a next method, we keep
    // things simple and return the next function itself.
    return function next() {
      while (keys.length) {
        var key = keys.pop();
        if (key in object) {
          next.value = key;
          next.done = false;
          return next;
        }
      }

      // To avoid creating an additional object, we just hang the .value
      // and .done properties off the next function object itself. This
      // also ensures that the minifier will not anonymize the function.
      next.done = true;
      return next;
    };
  };

  function values(iterable) {
    if (iterable != null) {
      var iteratorMethod = iterable[iteratorSymbol];
      if (iteratorMethod) {
        return iteratorMethod.call(iterable);
      }

      if (typeof iterable.next === "function") {
        return iterable;
      }

      if (!isNaN(iterable.length)) {
        var i = -1, next = function next() {
          while (++i < iterable.length) {
            if (hasOwn.call(iterable, i)) {
              next.value = iterable[i];
              next.done = false;
              return next;
            }
          }

          next.value = undefined;
          next.done = true;

          return next;
        };

        return next.next = next;
      }
    }

    throw new TypeError(typeof iterable + " is not iterable");
  }
  exports.values = values;

  function doneResult() {
    return { value: undefined, done: true };
  }

  Context.prototype = {
    constructor: Context,

    reset: function(skipTempReset) {
      this.prev = 0;
      this.next = 0;
      // Resetting context._sent for legacy support of Babel's
      // function.sent implementation.
      this.sent = this._sent = undefined;
      this.done = false;
      this.delegate = null;

      this.method = "next";
      this.arg = undefined;

      this.tryEntries.forEach(resetTryEntry);

      if (!skipTempReset) {
        for (var name in this) {
          // Not sure about the optimal order of these conditions:
          if (name.charAt(0) === "t" &&
              hasOwn.call(this, name) &&
              !isNaN(+name.slice(1))) {
            this[name] = undefined;
          }
        }
      }
    },

    stop: function() {
      this.done = true;

      var rootEntry = this.tryEntries[0];
      var rootRecord = rootEntry.completion;
      if (rootRecord.type === "throw") {
        throw rootRecord.arg;
      }

      return this.rval;
    },

    dispatchException: function(exception) {
      if (this.done) {
        throw exception;
      }

      var context = this;
      function handle(loc, caught) {
        record.type = "throw";
        record.arg = exception;
        context.next = loc;

        if (caught) {
          // If the dispatched exception was caught by a catch block,
          // then let that catch block handle the exception normally.
          context.method = "next";
          context.arg = undefined;
        }

        return !! caught;
      }

      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        var record = entry.completion;

        if (entry.tryLoc === "root") {
          // Exception thrown outside of any try block that could handle
          // it, so set the completion value of the entire function to
          // throw the exception.
          return handle("end");
        }

        if (entry.tryLoc <= this.prev) {
          var hasCatch = hasOwn.call(entry, "catchLoc");
          var hasFinally = hasOwn.call(entry, "finallyLoc");

          if (hasCatch && hasFinally) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            } else if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }

          } else if (hasCatch) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            }

          } else if (hasFinally) {
            if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }

          } else {
            throw new Error("try statement without catch or finally");
          }
        }
      }
    },

    abrupt: function(type, arg) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc <= this.prev &&
            hasOwn.call(entry, "finallyLoc") &&
            this.prev < entry.finallyLoc) {
          var finallyEntry = entry;
          break;
        }
      }

      if (finallyEntry &&
          (type === "break" ||
           type === "continue") &&
          finallyEntry.tryLoc <= arg &&
          arg <= finallyEntry.finallyLoc) {
        // Ignore the finally entry if control is not jumping to a
        // location outside the try/catch block.
        finallyEntry = null;
      }

      var record = finallyEntry ? finallyEntry.completion : {};
      record.type = type;
      record.arg = arg;

      if (finallyEntry) {
        this.method = "next";
        this.next = finallyEntry.finallyLoc;
        return ContinueSentinel;
      }

      return this.complete(record);
    },

    complete: function(record, afterLoc) {
      if (record.type === "throw") {
        throw record.arg;
      }

      if (record.type === "break" ||
          record.type === "continue") {
        this.next = record.arg;
      } else if (record.type === "return") {
        this.rval = this.arg = record.arg;
        this.method = "return";
        this.next = "end";
      } else if (record.type === "normal" && afterLoc) {
        this.next = afterLoc;
      }

      return ContinueSentinel;
    },

    finish: function(finallyLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.finallyLoc === finallyLoc) {
          this.complete(entry.completion, entry.afterLoc);
          resetTryEntry(entry);
          return ContinueSentinel;
        }
      }
    },

    "catch": function(tryLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc === tryLoc) {
          var record = entry.completion;
          if (record.type === "throw") {
            var thrown = record.arg;
            resetTryEntry(entry);
          }
          return thrown;
        }
      }

      // The context.catch method must only be called with a location
      // argument that corresponds to a known catch block.
      throw new Error("illegal catch attempt");
    },

    delegateYield: function(iterable, resultName, nextLoc) {
      this.delegate = {
        iterator: values(iterable),
        resultName: resultName,
        nextLoc: nextLoc
      };

      if (this.method === "next") {
        // Deliberately forget the last sent value so that we don't
        // accidentally pass it on to the delegate.
        this.arg = undefined;
      }

      return ContinueSentinel;
    }
  };

  // Regardless of whether this script is executing as a CommonJS module
  // or not, return the runtime object so that we can declare the variable
  // regeneratorRuntime in the outer scope, which allows this module to be
  // injected easily by `bin/regenerator --include-runtime script.js`.
  return exports;

}(
  // If this script is executing as a CommonJS module, use module.exports
  // as the regeneratorRuntime namespace. Otherwise create a new empty
  // object. Either way, the resulting object will be used to initialize
  // the regeneratorRuntime variable at the top of this file.
  typeof module === "object" ? module.exports : {}
));

try {
  regeneratorRuntime = runtime;
} catch (accidentalStrictMode) {
  // This module should not be running in strict mode, so the above
  // assignment should always work unless something is misconfigured. Just
  // in case runtime.js accidentally runs in strict mode, in modern engines
  // we can explicitly access globalThis. In older engines we can escape
  // strict mode using a global Function call. This could conceivably fail
  // if a Content Security Policy forbids using Function, but in that case
  // the proper solution is to fix the accidental strict mode problem. If
  // you've misconfigured your bundler to force strict mode and applied a
  // CSP to forbid Function, and you're not willing to fix either of those
  // problems, please detail your unique predicament in a GitHub issue.
  if (typeof globalThis === "object") {
    globalThis.regeneratorRuntime = runtime;
  } else {
    Function("r", "regeneratorRuntime = r")(runtime);
  }
}

'use strict';

function _regenerator() { var e, t, r = "function" == typeof Symbol ? Symbol : {}, n = r.iterator || "@@iterator", o = r.toStringTag || "@@toStringTag"; function i(r, n, o, i) { var c = n && n.prototype instanceof Generator ? n : Generator, u = Object.create(c.prototype); return _regeneratorDefine2(u, "_invoke", function (r, n, o) { var i, c, u, f = 0, p = o || [], y = !1, G = { p: 0, n: 0, v: e, a: d, f: d.bind(e, 4), d: function d(t, r) { return i = t, c = 0, u = e, G.n = r, a; } }; function d(r, n) { for (c = r, u = n, t = 0; !y && f && !o && t < p.length; t++) { var o, i = p[t], d = G.p, l = i[2]; r > 3 ? (o = l === n) && (u = i[(c = i[4]) ? 5 : (c = 3, 3)], i[4] = i[5] = e) : i[0] <= d && ((o = r < 2 && d < i[1]) ? (c = 0, G.v = n, G.n = i[1]) : d < l && (o = r < 3 || i[0] > n || n > l) && (i[4] = r, i[5] = n, G.n = l, c = 0)); } if (o || r > 1) return a; throw y = !0, n; } return function (o, p, l) { if (f > 1) throw TypeError("Generator is already running"); for (y && 1 === p && d(p, l), c = p, u = l; (t = c < 2 ? e : u) || !y;) { i || (c ? c < 3 ? (c > 1 && (G.n = -1), d(c, u)) : G.n = u : G.v = u); try { if (f = 2, i) { if (c || (o = "next"), t = i[o]) { if (!(t = t.call(i, u))) throw TypeError("iterator result is not an object"); if (!t.done) return t; u = t.value, c < 2 && (c = 0); } else 1 === c && (t = i.return) && t.call(i), c < 2 && (u = TypeError("The iterator does not provide a '" + o + "' method"), c = 1); i = e; } else if ((t = (y = G.n < 0) ? u : r.call(n, G)) !== a) break; } catch (t) { i = e, c = 1, u = t; } finally { f = 1; } } return { value: t, done: y }; }; }(r, o, i), !0), u; } var a = {}; function Generator() {} function GeneratorFunction() {} function GeneratorFunctionPrototype() {} t = Object.getPrototypeOf; var c = [][n] ? t(t([][n]())) : (_regeneratorDefine2(t = {}, n, function () { return this; }), t), u = GeneratorFunctionPrototype.prototype = Generator.prototype = Object.create(c); function f(e) { return Object.setPrototypeOf ? Object.setPrototypeOf(e, GeneratorFunctionPrototype) : (e.__proto__ = GeneratorFunctionPrototype, _regeneratorDefine2(e, o, "GeneratorFunction")), e.prototype = Object.create(u), e; } return GeneratorFunction.prototype = GeneratorFunctionPrototype, _regeneratorDefine2(u, "constructor", GeneratorFunctionPrototype), _regeneratorDefine2(GeneratorFunctionPrototype, "constructor", GeneratorFunction), GeneratorFunction.displayName = "GeneratorFunction", _regeneratorDefine2(GeneratorFunctionPrototype, o, "GeneratorFunction"), _regeneratorDefine2(u), _regeneratorDefine2(u, o, "Generator"), _regeneratorDefine2(u, n, function () { return this; }), _regeneratorDefine2(u, "toString", function () { return "[object Generator]"; }), (_regenerator = function _regenerator() { return { w: i, m: f }; })(); }
function _regeneratorDefine2(e, r, n, t) { var i = Object.defineProperty; try { i({}, "", {}); } catch (e) { i = 0; } _regeneratorDefine2 = function _regeneratorDefine(e, r, n, t) { function o(r, n) { _regeneratorDefine2(e, r, function (e) { return this._invoke(r, n, e); }); } r ? i ? i(e, r, { value: n, enumerable: !t, configurable: !t, writable: !t }) : e[r] = n : (o("next", 0), o("throw", 1), o("return", 2)); }, _regeneratorDefine2(e, r, n, t); }
function ownKeys(e, r) { var t = Object.keys(e); if (Object.getOwnPropertySymbols) { var o = Object.getOwnPropertySymbols(e); r && (o = o.filter(function (r) { return Object.getOwnPropertyDescriptor(e, r).enumerable; })), t.push.apply(t, o); } return t; }
function _objectSpread(e) { for (var r = 1; r < arguments.length; r++) { var t = null != arguments[r] ? arguments[r] : {}; r % 2 ? ownKeys(Object(t), !0).forEach(function (r) { _defineProperty(e, r, t[r]); }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function (r) { Object.defineProperty(e, r, Object.getOwnPropertyDescriptor(t, r)); }); } return e; }
function _defineProperty(e, r, t) { return (r = _toPropertyKey(r)) in e ? Object.defineProperty(e, r, { value: t, enumerable: !0, configurable: !0, writable: !0 }) : e[r] = t, e; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == _typeof(i) ? i : i + ""; }
function _toPrimitive(t, e) { if ("object" != _typeof(t) || !t) return t; var r; if ("undefined" != typeof Symbol && void 0 !== (r = t[Symbol.toPrimitive])) { var i = r.call(t, e || "default"); if ("object" != _typeof(i)) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === e ? String : Number)(t); }
function _createForOfIteratorHelper(r, e) { var t = "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"]; if (!t) { if (Array.isArray(r) || (t = _unsupportedIterableToArray(r)) || e && r && "number" == typeof r.length) { t && (r = t); var _n = 0, F = function F() {}; return { s: F, n: function n() { return _n >= r.length ? { done: !0 } : { done: !1, value: r[_n++] }; }, e: function e(r) { throw r; }, f: F }; } throw new TypeError("Invalid attempt to iterate non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); } var o, a = !0, u = !1; return { s: function s() { t = t.call(r); }, n: function n() { var r = t.next(); return a = r.done, r; }, e: function e(r) { u = !0, o = r; }, f: function f() { try { a || null == t.return || t.return(); } finally { if (u) throw o; } } }; }
function _toConsumableArray(r) { return _arrayWithoutHoles(r) || _iterableToArray(r) || _unsupportedIterableToArray(r) || _nonIterableSpread(); }
function _nonIterableSpread() { throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); }
function _unsupportedIterableToArray(r, a) { if (r) { if ("string" == typeof r) return _arrayLikeToArray(r, a); var t = {}.toString.call(r).slice(8, -1); return "Object" === t && r.constructor && (t = r.constructor.name), "Map" === t || "Set" === t ? Array.from(r) : "Arguments" === t || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t) ? _arrayLikeToArray(r, a) : void 0; } }
function _iterableToArray(r) { if ("undefined" != typeof Symbol && null != r[Symbol.iterator] || null != r["@@iterator"]) return Array.from(r); }
function _arrayWithoutHoles(r) { if (Array.isArray(r)) return _arrayLikeToArray(r); }
function _arrayLikeToArray(r, a) { (null == a || a > r.length) && (a = r.length); for (var e = 0, n = Array(a); e < a; e++) n[e] = r[e]; return n; }
function _typeof(o) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (o) { return typeof o; } : function (o) { return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o; }, _typeof(o); }
function asyncGeneratorStep(n, t, e, r, o, a, c) { try { var i = n[a](c), u = i.value; } catch (n) { return void e(n); } i.done ? t(u) : Promise.resolve(u).then(r, o); }
function _asyncToGenerator(n) { return function () { var t = this, e = arguments; return new Promise(function (r, o) { var a = n.apply(t, e); function _next(n) { asyncGeneratorStep(a, r, o, _next, _throw, "next", n); } function _throw(n) { asyncGeneratorStep(a, r, o, _next, _throw, "throw", n); } _next(void 0); }); }; }
window.MATDECK_APP_LOADED = true;
var CLIENT_VERSION = '1.3.1';
var CLIENT_BUILD = (document.querySelector('meta[name="matdeck-build"]') || {}).content || '';
(function detectFlexGap() {
  try {
    var box = document.createElement('div');
    box.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden';
    box.appendChild(document.createElement('div'));
    box.appendChild(document.createElement('div'));
    document.documentElement.appendChild(box);
    var supported = box.scrollHeight === 1;
    document.documentElement.removeChild(box);
    if (!supported) document.documentElement.classList.add('no-flex-gap');
  } catch (e) {}
})();
var NO_GRID = function detectGrid() {
  try {
    if (/[?&]compat=1\b/.test(location.search)) return true;
    return !(window.CSS && typeof CSS.supports === 'function' && CSS.supports('display', 'grid'));
  } catch (e) {
    return false;
  }
}();
if (NO_GRID) document.documentElement.classList.add('no-grid');
var NO_OBJECT_FIT = !('objectFit' in document.documentElement.style);
if (navigator.standalone === true) document.documentElement.classList.add('ios-standalone');
var ws = null;
var wsReconnectTimer = null;
var currentProfile = 'default';
var currentProfileName = '';
var keysData = [];
var profileList = null;
var hasLoadedProfile = false;
var connectionState = 'connecting';
var serverAddress = '';
var activeDragCleanups = new Set();
var VOLUME_THROTTLE_MS = 50;
var DRAG_THRESHOLD_PX = 6;
var SWIPE_MIN_X = 80;
var SWIPE_MAX_Y = 40;
var SWIPE_LABEL_MS = 900;
var THEME_KEY = 'matdeck.theme';
var FONT_KEY = 'matdeck.font';
var $ = function $(id) {
  return document.getElementById(id);
};
var gridWrap = $('deck-grid-wrap');
var gridEl = $('deck-grid');
var deckOverlay = $('deck-overlay');
var deckOverlayTitle = $('deck-overlay-title');
var deckOverlaySub = $('deck-overlay-sub');
var deckOverlayMain = $('deck-overlay-main');
var pairCard = $('pair-card');
var pairForm = $('pair-form');
var pairPin = $('pair-pin');
var pairSubmit = $('pair-submit');
var pairStatus = $('pair-status');
var swipeLabel = $('swipe-label');
var hardwareHud = $('hardware-hud');
var connDot = $('conn-dot');
var sheetBackdrop = $('sheet');
var sheetClose = $('sheet-close');
var sheetTitle = $('sheet-title');
var sheetStatusDot = $('sheet-status-dot');
var sheetProfile = $('sheet-profile');
var sheetIp = $('sheet-ip');
var themeSeg = $('theme-seg');
var fontSeg = $('font-seg');
var btnFullscreen = $('btn-fullscreen');
var btnFullscreenLabel = $('btn-fullscreen-label');
var btnFullscreenCorner = $('btn-fullscreen-corner');
var hudCpuVal = $('hud-cpu-val');
var hudCpuTemp = $('hud-cpu-temp');
var hudCpuBar = $('hud-cpu-bar');
var hudGpuVal = $('hud-gpu-val');
var hudGpuTemp = $('hud-gpu-temp');
var hudGpuBar = $('hud-gpu-bar');
var hudVramVal = $('hud-vram-val');
var hudVramPct = $('hud-vram-pct');
var hudVramBar = $('hud-vram-bar');
var hudRamVal = $('hud-ram-val');
var hudRamPct = $('hud-ram-pct');
var hudRamBar = $('hud-ram-bar');
var hudGpuCard = $('hud-gpu');
var hudVramCard = $('hud-vram');
var hudRamCard = $('hud-ram');
var toastContainer = $('toast-container');
function apiFetch(_x, _x2) {
  return _apiFetch.apply(this, arguments);
}
function _apiFetch() {
  _apiFetch = _asyncToGenerator(_regenerator().m(function _callee(url, options) {
    var res, data, text, _t;
    return _regenerator().w(function (_context) {
      while (1) switch (_context.p = _context.n) {
        case 0:
          _context.p = 0;
          _context.n = 1;
          return fetch(url, options);
        case 1:
          res = _context.v;
          data = null;
          _context.n = 2;
          return res.text();
        case 2:
          text = _context.v;
          if (text) {
            try {
              data = JSON.parse(text);
            } catch (e) {
              data = null;
            }
          }
          return _context.a(2, {
            ok: res.ok,
            status: res.status,
            data: data
          });
        case 3:
          _context.p = 3;
          _t = _context.v;
          return _context.a(2, {
            ok: false,
            status: 0,
            data: null,
            error: _t
          });
      }
    }, _callee, null, [[0, 3]]);
  }));
  return _apiFetch.apply(this, arguments);
}
function wsSend(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function setHidden(el, hidden) {
  if (!el) return;
  if (hidden) el.setAttribute('hidden', '');else el.removeAttribute('hidden');
}
function fmtTemp(temp) {
  return temp === null || temp === undefined || Number.isNaN(Number(temp)) ? '--°C' : "".concat(Math.round(temp), "\xB0C");
}
function fmtPct(v) {
  return v === null || v === undefined || Number.isNaN(Number(v)) ? '--%' : "".concat(Math.round(v), "%");
}
function fmtGb(v) {
  return v === null || v === undefined || Number.isNaN(Number(v)) ? '-- GB' : "".concat(Number(v).toFixed(1), " GB");
}
function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}
function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {}
}
function toast(message) {
  var opts = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
  var _opts$type = opts.type,
    type = _opts$type === void 0 ? 'info' : _opts$type,
    _opts$duration = opts.duration,
    duration = _opts$duration === void 0 ? 4000 : _opts$duration,
    _opts$title = opts.title,
    title = _opts$title === void 0 ? '' : _opts$title,
    _opts$onClose = opts.onClose,
    onClose = _opts$onClose === void 0 ? null : _opts$onClose;
  var el = document.createElement('div');
  el.className = "toast toast-".concat(type);
  el.setAttribute('role', type === 'error' || type === 'poke' ? 'alert' : 'status');
  var body = document.createElement('div');
  body.className = 'toast-body';
  if (title) {
    var titleEl = document.createElement('span');
    titleEl.className = 'toast-title';
    titleEl.textContent = title;
    body.appendChild(titleEl);
  }
  if (message) {
    var text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;
    body.appendChild(text);
  }
  var close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Fechar aviso');
  close.innerHTML = '<svg class="ico" aria-hidden="true"><use xlink:href="#i-close" href="#i-close"/></svg>';
  el.appendChild(body);
  el.appendChild(close);
  toastContainer.appendChild(el);
  var timer = null;
  var closed = false;
  var dismiss = function dismiss() {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    el.classList.add('toast-leaving');
    setTimeout(function () {
      return el.remove();
    }, 180);
    if (typeof onClose === 'function') onClose();
  };
  close.addEventListener('click', dismiss);
  if (duration > 0) timer = setTimeout(dismiss, duration);
  while (toastContainer.children.length > 4) toastContainer.firstElementChild.remove();
  return dismiss;
}
var NOTIFY_TYPE_BY_LEVEL = {
  info: 'info',
  success: 'success',
  warn: 'warning',
  poke: 'poke'
};
var NOTIFY_TTL_MIN = 1500;
var NOTIFY_TTL_MAX = 30000;
var notifyDismissers = new Map();
function showServerNotification(n) {
  var title = typeof n.title === 'string' ? n.title.trim() : '';
  var text = typeof n.text === 'string' ? n.text.trim() : '';
  if (!title && !text) return;
  var level = NOTIFY_TYPE_BY_LEVEL[n.level] ? n.level : 'info';
  var ttl = Number(n.ttlMs);
  var duration = clamp(Number.isFinite(ttl) && ttl > 0 ? ttl : 5000, NOTIFY_TTL_MIN, NOTIFY_TTL_MAX);
  var id = typeof n.id === 'string' || typeof n.id === 'number' ? String(n.id) : null;
  if (id && notifyDismissers.has(id)) notifyDismissers.get(id)();
  var dismiss = toast(text || title, {
    type: NOTIFY_TYPE_BY_LEVEL[level],
    title: text ? title : '',
    duration: duration,
    onClose: function onClose() {
      if (id && notifyDismissers.get(id) === dismiss) notifyDismissers.delete(id);
    }
  });
  if (id) notifyDismissers.set(id, dismiss);
  if (level === 'poke') pokeAttention();
}
function pokeAttention() {
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate([120, 60, 120]);
  } catch (e) {}
  playBeep();
}
var beepCtx = null;
function playBeep() {
  try {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!beepCtx) beepCtx = new Ctx();
    if (beepCtx.state === 'suspended') {
      beepCtx.resume().catch(function () {});
    }
    var t = beepCtx.currentTime;
    var osc = beepCtx.createOscillator();
    var gain = beepCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.setValueAtTime(1175, t + 0.09);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(gain);
    gain.connect(beepCtx.destination);
    osc.start(t);
    osc.stop(t + 0.22);
  } catch (e) {}
}
function setConnectionState(state) {
  connectionState = state;
  document.body.classList.toggle('is-offline', state !== 'connected');
  renderConnectionUI();
  if (state === 'connected') {
    if (hasLoadedProfile) hideDeckOverlay();else showDeckOverlay('Carregando perfil...', 'Aguardando o servidor enviar as teclas.', true);
  } else if (state === 'connecting') {
    showDeckOverlay(hasLoadedProfile ? 'Reconectando...' : 'Conectando ao servidor...', hasLoadedProfile ? 'As teclas voltam a responder assim que a conexão for restabelecida.' : 'As teclas aparecem assim que o MatDeck responder.', true);
  } else {
    showDeckOverlay('Servidor indisponível', 'Verifique se o MatDeck está em execução neste PC. Tentando reconectar...', true);
  }
}
function showDeckOverlay(title, sub, busy) {
  deckOverlayTitle.textContent = title;
  deckOverlaySub.textContent = sub || '';
  setHidden(deckOverlay, false);
  gridEl.setAttribute('aria-busy', busy ? 'true' : 'false');
}
function hideDeckOverlay() {
  setHidden(deckOverlay, true);
  gridEl.setAttribute('aria-busy', 'false');
}
function initWebSocket() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  var loc = window.location;
  var wsUrl = (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + '/deck';
  setConnectionState('connecting');
  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    setConnectionState('offline');
    wsReconnectTimer = setTimeout(initWebSocket, 2500);
    return;
  }
  ws.onopen = function () {
    setConnectionState('connected');
    wsSend({
      event: 'clientHello',
      device: 'Web Client',
      version: CLIENT_VERSION,
      build: CLIENT_BUILD,
      width: window.innerWidth,
      height: window.innerHeight
    });
  };
  ws.onmessage = function (event) {
    try {
      handleServerMessage(JSON.parse(event.data));
    } catch (e) {
      console.error('Erro ao ler WebSocket:', e);
      toast('Erro ao processar mensagem do servidor: ' + (e && e.message || e), {
        type: 'error',
        duration: 8000
      });
    }
  };
  ws.onclose = function () {
    setConnectionState('offline');
    cancelAllDrags();
    if (!wsReconnectTimer) wsReconnectTimer = setTimeout(startSession, 2500);
  };
  ws.onerror = function () {
    try {
      ws.close();
    } catch (e) {}
  };
}
function layoutDump() {
  var props = ['display', 'position', 'flexDirection', 'justifyContent', 'alignItems', 'flex', 'width', 'height', 'fontSize', 'padding', 'textAlign', 'objectFit', 'objectPosition', 'transform', 'marginLeft'];
  var _node = function node(el, depth) {
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    var out = {
      c: (el.getAttribute('class') || el.tagName).slice(0, 70),
      r: [r.left, r.top, r.width, r.height].map(Math.round),
      sw: el.scrollWidth,
      cw: el.clientWidth,
      t: el.children.length ? '' : (el.textContent || '').slice(0, 30)
    };
    for (var _i = 0, _props = props; _i < _props.length; _i++) {
      var p = _props[_i];
      out[p] = cs[p];
    }
    if (depth > 0 && el.children.length) out.ch = Array.from(el.children).slice(0, 10).map(function (c) {
      return _node(c, depth - 1);
    });
    return out;
  };
  return {
    ua: navigator.userAgent,
    w: window.innerWidth,
    h: window.innerHeight,
    html: document.documentElement.className,
    keys: Array.from(gridEl.children).map(function (k) {
      return _node(k, 3);
    })
  };
}
function handleServerMessage(msg) {
  if (!msg || _typeof(msg) !== 'object') return;
  switch (msg.event) {
    case 'loadProfile':
      {
        currentProfile = msg.id;
        currentProfileName = msg.name || msg.id || '';
        keysData = Array.isArray(msg.keys) ? msg.keys : [];
        var rows = msg.rows || 3;
        var cols = msg.cols || 5;
        gridEl.style.gridTemplateColumns = "repeat(".concat(cols, ", 1fr)");
        gridEl.style.gridTemplateRows = "repeat(".concat(rows, ", 1fr)");
        setHidden(hardwareHud, msg.showHardwareHud !== true);
        hasLoadedProfile = true;
        hideDeckOverlay();
        renderGrid(rows, cols);
        renderConnectionUI();
        break;
      }
    case 'updateKey':
      {
        var idx = msg.keyIndex;
        if (msg.key && typeof idx === 'number') {
          var existing = keysData.find(function (k) {
            return k && k.index === idx;
          });
          if (existing) {
            Object.assign(existing, msg.key);
            updateSingleKeyUI(idx);
          }
        }
        break;
      }
    case 'hardwareStats':
      updateHardwareHud(msg.stats);
      break;
    case 'layoutDump':
      wsSend({
        event: 'layoutDump',
        dump: layoutDump()
      });
      break;
    case 'reload':
      if (msg.version && sessionStorage.getItem('matdeck-reloaded-for') !== msg.version) {
        try {
          sessionStorage.setItem('matdeck-reloaded-for', msg.version);
        } catch (e) {}
        setTimeout(function () {
          return location.reload();
        }, 300);
      }
      break;
    case 'notify':
      showServerNotification(msg);
      break;
    case 'profileList':
      if (Array.isArray(msg.profiles)) {
        profileList = msg.profiles.filter(function (p) {
          return p && p.id;
        });
        if (msg.current) currentProfile = msg.current;
        var entry = profileList.find(function (p) {
          return p.id === currentProfile;
        });
        if (entry && entry.name) currentProfileName = entry.name;
        renderConnectionUI();
      }
      break;
    default:
      break;
  }
}
var TEMP_HOT = 75;
function setBar(bar, pct, isHot) {
  var v = pct === null || pct === undefined || Number.isNaN(Number(pct)) ? 0 : clamp(Number(pct), 0, 100);
  bar.style.width = "".concat(v, "%");
  bar.classList.toggle('is-hot', !!isHot);
}
function updateHardwareHud(stats) {
  if (!stats) return;
  if (stats.cpu) {
    var hot = typeof stats.cpu.temp === 'number' && stats.cpu.temp >= TEMP_HOT;
    hudCpuVal.textContent = fmtPct(stats.cpu.usage);
    hudCpuTemp.textContent = fmtTemp(stats.cpu.temp);
    hudCpuTemp.classList.toggle('is-hot', hot);
    hudCpuTemp.classList.toggle('is-unknown', stats.cpu.temp === null || stats.cpu.temp === undefined);
    setBar(hudCpuBar, stats.cpu.usage, hot);
  }
  if (stats.gpu) {
    var gpuAvailable = stats.gpu.available !== false;
    hudGpuCard.classList.toggle('is-unavailable', !gpuAvailable);
    hudVramCard.classList.toggle('is-unavailable', !gpuAvailable);
    hudGpuCard.title = gpuAvailable ? '' : 'Nenhuma GPU monitorada neste PC';
    hudVramCard.title = gpuAvailable ? '' : 'Nenhuma GPU monitorada neste PC';
    if (gpuAvailable) {
      var _hot = typeof stats.gpu.temp === 'number' && stats.gpu.temp >= TEMP_HOT;
      hudGpuVal.textContent = fmtPct(stats.gpu.usage);
      hudGpuTemp.textContent = fmtTemp(stats.gpu.temp);
      hudGpuTemp.classList.toggle('is-hot', _hot);
      hudGpuTemp.classList.toggle('is-unknown', stats.gpu.temp === null || stats.gpu.temp === undefined);
      setBar(hudGpuBar, stats.gpu.usage, _hot);
      hudVramVal.textContent = fmtGb(stats.gpu.vramUsedGB);
      hudVramPct.textContent = fmtPct(stats.gpu.vramPercent);
      setBar(hudVramBar, stats.gpu.vramPercent);
    } else {
      hudGpuVal.textContent = '--%';
      hudGpuTemp.textContent = '--°C';
      hudGpuTemp.classList.remove('is-hot');
      setBar(hudGpuBar, 0);
      hudVramVal.textContent = '-- GB';
      hudVramPct.textContent = '--%';
      setBar(hudVramBar, 0);
    }
  }
  if (stats.ram) {
    hudRamVal.textContent = fmtGb(stats.ram.usedGB);
    hudRamPct.textContent = fmtPct(stats.ram.percent);
    setBar(hudRamBar, stats.ram.percent);
    if (typeof stats.ram.freeGB === 'number') {
      hudRamCard.title = "".concat(stats.ram.freeGB.toFixed(1), " GB livres");
    }
  }
}
function cancelAllDrags() {
  for (var _i2 = 0, _arr = _toConsumableArray(activeDragCleanups); _i2 < _arr.length; _i2++) {
    var cleanup = _arr[_i2];
    cleanup();
  }
  activeDragCleanups.clear();
}
var gridRows = 3;
var gridCols = 5;
function spanOf(cfg) {
  var cols = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : gridCols;
  var rows = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : gridRows;
  if (!cfg) return {
    cols: 1,
    rows: 1
  };
  var c = Math.max(1, parseInt(cfg.colSpan, 10) || 1);
  var r = Math.max(1, parseInt(cfg.rowSpan, 10) || (cfg.tall && isSliderKey(cfg) ? 2 : 1));
  var col = cfg.index % cols;
  var row = Math.floor(cfg.index / cols);
  c = Math.min(c, cols - col);
  r = Math.min(r, rows - row);
  return {
    cols: c,
    rows: r
  };
}
function isTallKey(cfg) {
  if (!cfg || !isSliderKey(cfg) || isWideKey(cfg)) return false;
  var sp = spanOf(cfg);
  return sp.rows > 1 && sp.cols === 1;
}
function coveredIndexes() {
  var covered = new Set();
  var _iterator = _createForOfIteratorHelper(keysData),
    _step;
  try {
    for (_iterator.s(); !(_step = _iterator.n()).done;) {
      var k = _step.value;
      var sp = spanOf(k);
      if (sp.cols === 1 && sp.rows === 1) continue;
      var col = k.index % gridCols,
        row = Math.floor(k.index / gridCols);
      for (var r = 0; r < sp.rows; r++) for (var c = 0; c < sp.cols; c++) {
        if (r || c) covered.add((row + r) * gridCols + col + c);
      }
    }
  } catch (err) {
    _iterator.e(err);
  } finally {
    _iterator.f();
  }
  return covered;
}
function gridGapPx() {
  try {
    var v = parseFloat(getComputedStyle(gridEl).getPropertyValue('--space-2'));
    return Number.isFinite(v) ? v : 8;
  } catch (e) {
    return 8;
  }
}
function placeKey(el, index, sp, cols, rows, gap) {
  var col = index % cols;
  var row = Math.floor(index / cols);
  if (!NO_GRID) {
    el.style.gridColumn = "".concat(col + 1, " / span ").concat(sp.cols);
    el.style.gridRow = "".concat(row + 1, " / span ").concat(sp.rows);
    return;
  }
  var cw = "(100% - ".concat((cols - 1) * gap, "px) / ").concat(cols);
  var rh = "(100% - ".concat((rows - 1) * gap, "px) / ").concat(rows);
  el.style.left = "calc(".concat(cw, " * ").concat(col, " + ").concat(col * gap, "px)");
  el.style.top = "calc(".concat(rh, " * ").concat(row, " + ").concat(row * gap, "px)");
  el.style.width = "calc(".concat(cw, " * ").concat(sp.cols, " + ").concat((sp.cols - 1) * gap, "px)");
  el.style.height = "calc(".concat(rh, " * ").concat(sp.rows, " + ").concat((sp.rows - 1) * gap, "px)");
}
function renderGrid() {
  var rows = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : 3;
  var cols = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 5;
  cancelAllDrags();
  gridEl.innerHTML = '';
  gridRows = rows;
  gridCols = cols;
  var total = rows * cols;
  var covered = coveredIndexes();
  var gap = gridGapPx();
  var _loop = function _loop(i) {
    if (covered.has(i)) return 1;
    var keyConfig = keysData.find(function (k) {
      return k.index === i;
    }) || {
      index: i,
      title: ''
    };
    var el = createKeyElement(keyConfig);
    var sp = spanOf(keyConfig);
    placeKey(el, i, sp, cols, rows, gap);
    if (sp.cols > 1 || sp.rows > 1) el.classList.add('key-span');
    gridEl.appendChild(el);
  };
  for (var i = 0; i < total; i++) {
    if (_loop(i)) continue;
  }
  requestAnimationFrame(fitAllIcons);
}
function renderSkeletonGrid() {
  var rows = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : 3;
  var cols = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 5;
  gridEl.innerHTML = '';
  gridEl.style.gridTemplateColumns = "repeat(".concat(cols, ", 1fr)");
  gridEl.style.gridTemplateRows = "repeat(".concat(rows, ", 1fr)");
  var gap = gridGapPx();
  for (var i = 0; i < rows * cols; i++) {
    var el = document.createElement('div');
    el.className = 'deck-key deck-key-skeleton';
    el.setAttribute('aria-hidden', 'true');
    placeKey(el, i, {
      cols: 1,
      rows: 1
    }, cols, rows, gap);
    gridEl.appendChild(el);
  }
}
function isKeyMuted(cfg) {
  return cfg.bgColor === '#DC2626' || cfg.badge === 'MUDO' || cfg.badge === 'MUTADO' || cfg.title && cfg.title.toUpperCase().includes('MUTADO');
}
function isHoldKey(cfg) {
  return /^(discord:ptt|ts:ptt|ts:whisper|data:talk)$/.test(String(cfg && cfg.actionId || ''));
}
function isSliderKey(cfg) {
  return !!(cfg.isSlider || cfg.actionId && (cfg.actionId.startsWith('vol_slider:') || cfg.actionId === 'spotify:mixer'));
}
function isWideKey(cfg) {
  return !!cfg && isSliderKey(cfg) && (cfg.sliderDir === 'h' || cfg.actionId === 'spotify:mixer');
}
function isDarkColor(hex) {
  var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return false;
  var n = parseInt(m[1], 16);
  var r = n >> 16 & 255,
    g = n >> 8 & 255,
    b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
}
function isStatKey(cfg) {
  return !!(cfg && (cfg.actionId && (cfg.actionId.startsWith('stats:') || cfg.actionId.startsWith('ai:')) || cfg.statValue !== undefined || cfg.statMode === 'media' || cfg.statMode === 'meters' || cfg.actionId === 'spotify:now_playing' || cfg.actionId === 'player:now_playing' || cfg.actionId === 'player:panel' || cfg.actionId === 'discord:voice_room'));
}
function escHtml(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c];
  });
}
function statChartSvg(cfg, prefix) {
  var W = 100,
    H = 40,
    N = 60;
  var h1 = Array.isArray(cfg.statHistory) ? cfg.statHistory : [];
  var h2 = Array.isArray(cfg.statHistory2) ? cfg.statHistory2 : [];
  var max = cfg.statHistoryMax || Math.max.apply(Math, [1].concat(_toConsumableArray(h1), _toConsumableArray(h2)));
  var min = cfg.statHistoryMin || 0;
  var span = Math.max(1, max - min);
  var line = function line(hist) {
    var n = hist.length;
    if (!n) return null;
    var step = W / (N - 1);
    var x0 = W - (n - 1) * step;
    var pts = hist.map(function (v, i) {
      return "".concat((x0 + i * step).toFixed(1), ",").concat((H - Math.min(H, Math.max(0, (v - min) / span) * H)).toFixed(1));
    });
    return {
      pts: pts.join(' '),
      xStart: x0.toFixed(1)
    };
  };
  var c1 = cfg.statColor || '#3B82F6';
  var c2 = cfg.statColor2 || '#EC4899';
  var out = "<svg class=\"".concat(prefix, "-chart-svg\" viewBox=\"0 0 ").concat(W, " ").concat(H, "\" preserveAspectRatio=\"none\" aria-hidden=\"true\">");
  var kind = cfg.statChart === 'line' || cfg.statChart === 'bars' ? cfg.statChart : 'area';
  if (kind === 'bars') {
    var bars = function bars(hist, color, opacity) {
      var n = hist.length;
      if (!n) return '';
      var step = W / N;
      var bw = Math.max(0.6, step * 0.7);
      return hist.map(function (v, i) {
        var bh = Math.min(H, Math.max(0, (v - min) / span) * H);
        return "<rect x=\"".concat((W - (n - i) * step + (step - bw) / 2).toFixed(2), "\" y=\"").concat((H - bh).toFixed(2), "\" width=\"").concat(bw.toFixed(2), "\" height=\"").concat(Math.max(0.5, bh).toFixed(2), "\" fill=\"").concat(color, "\" fill-opacity=\"").concat(opacity, "\"/>");
      }).join('');
    };
    return out + bars(h1, c1, h2.length ? 0.9 : 1) + bars(h2, c2, 0.75) + '</svg>';
  }
  var l1 = line(h1);
  if (l1) out += (kind === 'area' ? "<polygon points=\"".concat(l1.xStart, ",").concat(H, " ").concat(l1.pts, " ").concat(W, ",").concat(H, "\" fill=\"").concat(c1, "\" fill-opacity=\"0.28\"/>") : '') + "<polyline points=\"".concat(l1.pts, "\" fill=\"none\" stroke=\"").concat(c1, "\" stroke-width=\"1.6\" vector-effect=\"non-scaling-stroke\" stroke-linejoin=\"round\"/>");
  var l2 = line(h2);
  if (l2) out += "<polyline points=\"".concat(l2.pts, "\" fill=\"none\" stroke=\"").concat(c2, "\" stroke-width=\"1.6\" vector-effect=\"non-scaling-stroke\" stroke-linejoin=\"round\"/>");
  return out + '</svg>';
}
function statBarsSvg(cfg, prefix) {
  var bars = Array.isArray(cfg.statBars) ? cfg.statBars : [];
  var W = 100,
    H = 40;
  if (!bars.length) return '';
  var two = bars.length > 16;
  var rows = two ? 2 : 1;
  var perRow = Math.ceil(bars.length / rows);
  var rowH = H / rows;
  var slot = W / perRow;
  var bw = Math.max(0.8, slot * 0.68);
  var out = "<svg class=\"".concat(prefix, "-chart-svg\" viewBox=\"0 0 ").concat(W, " ").concat(H, "\" preserveAspectRatio=\"none\" aria-hidden=\"true\">");
  bars.forEach(function (v, i) {
    var r = Math.floor(i / perRow),
      c = i % perRow;
    var bh = Math.max(1, Math.min(100, Math.max(0, v)) / 100 * (rowH - 3));
    var color = v >= 75 ? '#EF4444' : v >= 40 ? '#F59E0B' : cfg.statColor || '#3B82F6';
    out += "<rect x=\"".concat((c * slot + (slot - bw) / 2).toFixed(2), "\" y=\"").concat(((r + 1) * rowH - 1 - bh).toFixed(2), "\" width=\"").concat(bw.toFixed(2), "\" height=\"").concat(bh.toFixed(2), "\" rx=\"0.6\" fill=\"").concat(color, "\"/>");
    out += "<rect x=\"".concat((c * slot + (slot - bw) / 2).toFixed(2), "\" y=\"").concat((r * rowH + 2).toFixed(2), "\" width=\"").concat(bw.toFixed(2), "\" height=\"").concat((rowH - 3 - bh).toFixed(2), "\" fill=\"currentColor\" fill-opacity=\"0.12\"/>");
  });
  return out + '</svg>';
}
function statInnerHtml(cfg, prefix) {
  var mode = cfg.statMode || (Array.isArray(cfg.statHistory) ? 'graph' : 'bar');
  var color = cfg.statColor || cfg.badgeColor || '';
  if (cfg.statSwap && cfg.statBig !== undefined && cfg.statBig !== null && cfg.statHead) cfg = _objectSpread(_objectSpread({}, cfg), {}, {
    statBig: cfg.statHead,
    statHead: cfg.statBig
  });
  var html = "<div class=\"".concat(prefix, "-head\"><span class=\"").concat(prefix, "-label\">").concat(escHtml(cfg.statLabel || cfg.title || ''), "</span><span class=\"").concat(prefix, "-headval\">").concat(escHtml(cfg.statHead !== undefined ? cfg.statHead : cfg.statSub || ''), "</span></div>");
  if (mode === 'meters' && Array.isArray(cfg.statRows)) {
    html += "<div class=\"".concat(prefix, "-meters\">") + cfg.statRows.map(function (r) {
      return "<div class=\"".concat(prefix, "-meter\"><div class=\"").concat(prefix, "-meter-row\"><span class=\"").concat(prefix, "-meter-k\">").concat(escHtml(r.k), "</span><span class=\"").concat(prefix, "-meter-sub\">").concat(escHtml(r.sub || ''), "</span><span class=\"").concat(prefix, "-meter-v\">").concat(escHtml(r.v), "</span></div><div class=\"").concat(prefix, "-bar\"><i style=\"width:").concat(Math.max(0, Math.min(100, Number(r.pct) || 0)), "%;background:").concat(escHtml(r.color || color), "\"></i></div></div>");
    }).join('') + '</div>';
    return html;
  }
  if (mode === 'dual' && Array.isArray(cfg.statRows)) {
    html += "<div class=\"".concat(prefix, "-rows\">") + cfg.statRows.map(function (r) {
      return "<div class=\"".concat(prefix, "-row\"><span class=\"").concat(prefix, "-rowk\" style=\"color:").concat(escHtml(r.color || color), "\">").concat(escHtml(r.k), "</span><span class=\"").concat(prefix, "-rowv\">").concat(escHtml(r.v), "</span></div>");
    }).join('') + '</div>';
  } else if (cfg.statBig !== undefined && cfg.statBig !== null) {
    html += "<div class=\"".concat(prefix, "-big\">").concat(escHtml(cfg.statBig), "</div>");
  } else if (cfg.statValue !== undefined && mode !== 'cores') {
    html += "<div class=\"".concat(prefix, "-big\">").concat(escHtml(cfg.statValue), "</div>");
  }
  if (cfg.statSub && mode !== 'dual') html += "<div class=\"".concat(prefix, "-sub\" style=\"color:").concat(escHtml(color), "\">").concat(escHtml(cfg.statSub), "</div>");
  if ((mode === 'graph' || mode === 'dual') && cfg.statChart !== 'none') html += "<div class=\"".concat(prefix, "-chart\">").concat(statChartSvg(cfg, prefix), "</div>");else if (mode === 'cores') html += "<div class=\"".concat(prefix, "-chart ").concat(prefix, "-chart-tall\">").concat(statBarsSvg(cfg, prefix), "</div>");else if (cfg.statPercent !== undefined && cfg.statPercent !== null) html += "<div class=\"".concat(prefix, "-bar\"><i style=\"width:").concat(Math.max(0, Math.min(100, Number(cfg.statPercent) || 0)), "%;background:").concat(escHtml(color), "\"></i></div>");
  return html;
}
function renderStatContent(el, cfg) {
  var box = el.querySelector('.key-stat');
  if (!box) {
    box = document.createElement('div');
    box.className = 'key-stat';
    el.appendChild(box);
  }
  var mode = cfg.statMode || 'bar';
  box.className = "key-stat mode-".concat(mode);
  var fontScale = statFontScale(cfg);
  box.style.setProperty('--stat-font', fontScale === 1 ? '' : String(fontScale));
  var customText = cfg.titleColor && !isKeyMuted(cfg);
  box.style.color = customText ? cfg.titleColor : '';
  if (customText) box.classList.add('has-text-color');
  if (mode === 'media') {
    renderMediaContent(box, cfg);
    return;
  }
  box.innerHTML = statInnerHtml(cfg, 'key-stat');
  if (NO_GRID && fontScale !== 1) {
    var texts = box.querySelectorAll('.key-stat-label, .key-stat-headval, .key-stat-big, .key-stat-sub, .key-stat-rowk, .key-stat-rowv, .key-stat-meter-k, .key-stat-meter-v, .key-stat-meter-sub');
    for (var i = 0; i < texts.length; i++) {
      var px = parseFloat(window.getComputedStyle(texts[i]).fontSize);
      if (px) texts[i].style.fontSize = "".concat(Math.round(px * fontScale * 10) / 10, "px");
    }
  }
}
function statFontScale(cfg) {
  var v = cfg && cfg.statFont;
  if (v === 's') return 0.8;
  if (v === 'l') return 1.25;
  var n = Number(v);
  return n > 0 ? Math.min(2.5, Math.max(0.5, n)) : 1;
}
function renderMediaContent(box, cfg) {
  if (!box.querySelector('.key-stat-media-title')) {
    box.innerHTML = '<div class="key-stat-cover"></div><div class="key-stat-media-shade"></div>' + '<div class="key-stat-head"><span class="key-stat-label"></span><span class="key-stat-headval"></span></div>' + '<div class="key-stat-media-spacer"></div><div class="key-stat-media-title"></div><div class="key-stat-media-artist"></div>' + '<div class="key-stat-media-time"><span class="key-stat-media-pos"></span><span class="key-stat-media-len"></span></div>' + '<div class="key-stat-bar"><i></i></div>';
  }
  var setText = function setText(sel, v) {
    var n = box.querySelector(sel);
    var t = v === null || v === undefined ? '' : String(v);
    if (n && n.textContent !== t) n.textContent = t;
  };
  setText('.key-stat-label', cfg.statLabel || 'Spotify');
  setText('.key-stat-headval', cfg.statHead);
  setText('.key-stat-media-title', cfg.statBig);
  setText('.key-stat-media-artist', cfg.statSub);
  setText('.key-stat-media-pos', cfg.statTime);
  setText('.key-stat-media-len', cfg.statTotal);
  var cover = box.querySelector('.key-stat-cover');
  var img = cover.querySelector('img');
  if (cfg.statImage && NO_OBJECT_FIT) {
    if (cover.dataset.src !== cfg.statImage) {
      cover.style.backgroundImage = "url(\"".concat(cfg.statImage, "\")");
      cover.dataset.src = cfg.statImage;
    }
    box.classList.add('has-cover');
  } else if (cfg.statImage) {
    if (!img) {
      img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      cover.appendChild(img);
    }
    if (img.getAttribute('src') !== cfg.statImage) img.setAttribute('src', cfg.statImage);
    box.classList.add('has-cover');
  } else {
    if (img) img.remove();
    if (cover.dataset.src) {
      cover.style.backgroundImage = '';
      delete cover.dataset.src;
    }
    box.classList.remove('has-cover');
  }
  var bar = box.querySelector('.key-stat-bar i');
  bar.style.width = "".concat(Math.max(0, Math.min(100, Number(cfg.statPercent) || 0)), "%");
  bar.style.background = cfg.statColor || '#1DB954';
  if (cfg.active) box.classList.add('is-playing');else box.classList.remove('is-playing');
  syncMediaPanel(box, cfg);
}
function syncMediaPanel(box, cfg) {
  var bar = box.querySelector('.key-media-panel');
  if (!cfg.panel) {
    if (bar) bar.remove();
    box.classList.remove('has-panel');
    return;
  }
  box.classList.add('has-panel');
  var ic = cfg.panelIcons || box._panelIcons || {};
  if (cfg.panelIcons) box._panelIcons = cfg.panelIcons;
  var prefix = String(cfg.actionId || 'player:').split(':')[0];
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'key-media-panel';
    var labels = {
      seek_back: 'Voltar 10 s',
      play_pause: 'Play / Pause',
      seek_fwd: 'Avançar 10 s',
      mute: 'Mudo'
    };
    var _loop2 = function _loop2() {
      var cmd = _arr2[_i3];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = "key-media-btn key-media-".concat(cmd);
      b.setAttribute('aria-label', labels[cmd]);
      var img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      b.appendChild(img);
      var stop = function stop(e) {
        e.stopPropagation();
      };
      b.addEventListener('pointerdown', stop);
      b.addEventListener('pointerup', stop);
      b.addEventListener('touchstart', stop, {
        passive: true
      });
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        b.classList.add('is-pressed');
        setTimeout(function () {
          return b.classList.remove('is-pressed');
        }, 180);
        wsSend({
          event: 'action',
          actionId: "".concat(prefix, ":").concat(cmd)
        });
      });
      bar.appendChild(b);
    };
    for (var _i3 = 0, _arr2 = ['seek_back', 'play_pause', 'seek_fwd', 'mute']; _i3 < _arr2.length; _i3++) {
      _loop2();
    }
    box.appendChild(bar);
  }
  var setIcon = function setIcon(cmd, src) {
    var img = bar.querySelector(".key-media-".concat(cmd, " img"));
    if (img && src && img.getAttribute('src') !== src) img.setAttribute('src', src);
  };
  setIcon('seek_back', ic.seek_back);
  setIcon('seek_fwd', ic.seek_fwd);
  setIcon('play_pause', cfg.panelPlaying ? ic.pause : ic.play);
  setIcon('mute', cfg.panelMuted ? ic.mute : ic.unmute);
  bar.classList.toggle('is-playing', !!cfg.panelPlaying);
  bar.classList.toggle('is-muted', !!cfg.panelMuted);
}
function applyIconScale(el, cfg) {
  var scale = Number(cfg.iconScale) || 1;
  var img = el.querySelector('.key-icon');
  if (!img || cfg.imageFill || isStatKey(cfg)) return;
  var sp = spanOf(cfg);
  var tall = isTallKey(cfg);
  var base = 36;
  if (tall) {
    base = Math.min(40, el.clientWidth * 0.4 || 40);
  } else if (sp.cols > 1 || sp.rows > 1) {
    var m = Math.min(el.clientWidth, el.clientHeight);
    base = m ? Math.max(36, Math.min(160, m * 0.22)) : 36;
  }
  if (el.classList.contains('has-auto-btn')) base = tall ? 30 : 26;
  if (isWideKey(cfg)) base = 26;
  var px = Math.round(base * scale);
  img.style.width = "".concat(px, "px");
  img.style.height = "".concat(px, "px");
  if (tall) img.style.maxWidth = "".concat(px, "px");
}
function fitAllIcons() {
  var _iterator2 = _createForOfIteratorHelper(keysData),
    _step2;
  try {
    for (_iterator2.s(); !(_step2 = _iterator2.n()).done;) {
      var k = _step2.value;
      var el = document.getElementById("deck-key-".concat(k.index));
      if (el) applyIconScale(el, k);
    }
  } catch (err) {
    _iterator2.e(err);
  } finally {
    _iterator2.f();
  }
}
window.addEventListener('resize', function () {
  return requestAnimationFrame(fitAllIcons);
});
function sliderAppOf(cfg) {
  if (cfg.sliderApp) return cfg.sliderApp;
  if (cfg.actionId && cfg.actionId.startsWith('spotify:')) return 'spotify';
  return cfg.actionId ? cfg.actionId.replace('vol_slider:', '') : 'master';
}
function createKeyElement(cfg) {
  var el = document.createElement('div');
  var muted = isKeyMuted(cfg);
  var isSlider = isSliderKey(cfg);
  var hasAction = !!(cfg.actionId || cfg.title || isSlider || cfg.imageFill && cfg.icon);
  el.className = 'deck-key' + (cfg.active ? ' active-toggle' : '') + (cfg.pulse ? ' key-pulse' : '') + (muted ? ' key-muted' : '') + (isSlider ? ' key-slider' : '') + (hasAction ? '' : ' key-empty') + (isTallKey(cfg) ? ' key-tall' : '') + (isWideKey(cfg) ? ' key-wide' : '') + (cfg.actionId === 'spotify:mixer' ? ' key-mixer' : '') + (cfg.imageFill && cfg.icon ? ' key-image-fill' : '') + (isStatKey(cfg) ? ' key-stat-tile' : '') + (cfg.bgColor && !muted && isDarkColor(cfg.bgColor) ? ' has-dark-bg' : '');
  el.id = "deck-key-".concat(cfg.index);
  el.setAttribute('role', isSlider ? 'slider' : 'button');
  el.tabIndex = 0;
  el.dataset.index = String(cfg.index);
  applyKeyAccessibleName(el, cfg);
  if (cfg.borderColor && !muted) el.style.borderColor = cfg.borderColor;
  if (cfg.bgColor && !muted) el.style.backgroundColor = cfg.bgColor;
  if (isSlider) {
    var fill = document.createElement('div');
    fill.className = 'key-slider-fill';
    var val = cfg.sliderValue !== undefined ? cfg.sliderValue : 80;
    if (isWideKey(cfg)) {
      fill.style.height = '100%';
      fill.style.width = "".concat(val, "%");
      var track = document.createElement('div');
      track.className = 'key-slider-track key-slider-track-h';
      track.appendChild(fill);
      el.appendChild(track);
    } else if (isTallKey(cfg)) {
      fill.style.height = "".concat(val, "%");
      var _track = document.createElement('div');
      _track.className = 'key-slider-track';
      _track.appendChild(fill);
      el.appendChild(_track);
    } else {
      fill.style.height = "".concat(val, "%");
      el.appendChild(fill);
    }
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', '100');
    el.setAttribute('aria-valuenow', String(val));
    el.setAttribute('aria-orientation', isWideKey(cfg) ? 'horizontal' : 'vertical');
  }
  if (isStatKey(cfg)) {
    renderStatContent(el, cfg);
    attachKeyInteraction(el, cfg);
    return el;
  }
  if (cfg.badge) {
    var badge = document.createElement('span');
    badge.className = 'key-badge';
    badge.textContent = cfg.badge;
    if (cfg.badgeColor && !muted) badge.style.backgroundColor = cfg.badgeColor;
    el.appendChild(badge);
  }
  if (cfg.icon) {
    var img = document.createElement('img');
    img.className = 'key-icon';
    img.src = cfg.icon;
    img.alt = '';
    img.draggable = false;
    el.appendChild(img);
  }
  var title = document.createElement('span');
  title.className = 'key-title';
  title.textContent = cfg.title || '';
  if (cfg.titleColor && !muted) title.style.color = cfg.titleColor;
  el.appendChild(title);
  syncAutoButton(el, cfg);
  syncTransport(el, cfg);
  applyIconScale(el, cfg);
  attachKeyInteraction(el, cfg);
  return el;
}
function syncTransport(el, cfg) {
  var wants = !!cfg.transport || cfg.actionId === 'spotify:transport' || cfg.actionId === 'player:transport' || cfg.actionId === 'spotify:mixer';
  var bar = el.querySelector('.key-transport-bar');
  if (cfg.actionId) el.dataset.transportPrefix = String(cfg.actionId).split(':')[0];
  el.classList.toggle('key-transport', wants);
  if (!wants) {
    if (bar) bar.remove();
    return;
  }
  var ic = cfg.transportIcons || el._transportIcons || {};
  if (cfg.transportIcons) el._transportIcons = cfg.transportIcons;
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'key-transport-bar';
    var _loop3 = function _loop3() {
      var cmd = _arr3[_i4];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = "key-transport-btn key-transport-".concat(cmd);
      b.dataset.cmd = cmd;
      b.setAttribute('aria-label', {
        prev: 'Faixa anterior',
        play_pause: 'Play / Pause',
        next: 'Próxima faixa'
      }[cmd]);
      var img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      b.appendChild(img);
      var stop = function stop(e) {
        e.stopPropagation();
      };
      b.addEventListener('pointerdown', stop);
      b.addEventListener('pointerup', stop);
      b.addEventListener('touchstart', stop, {
        passive: true
      });
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        b.classList.add('is-pressed');
        setTimeout(function () {
          return b.classList.remove('is-pressed');
        }, 180);
        wsSend({
          event: 'action',
          actionId: "".concat(el.dataset.transportPrefix || 'spotify', ":").concat(cmd)
        });
      });
      bar.appendChild(b);
    };
    for (var _i4 = 0, _arr3 = ['prev', 'play_pause', 'next']; _i4 < _arr3.length; _i4++) {
      _loop3();
    }
    var title = el.querySelector('.key-title');
    el.insertBefore(bar, title || null);
  }
  var setIcon = function setIcon(cmd, src) {
    var img = bar.querySelector(".key-transport-".concat(cmd, " img"));
    if (img && src && img.getAttribute('src') !== src) img.setAttribute('src', src);
  };
  setIcon('prev', ic.prev);
  setIcon('next', ic.next);
  setIcon('play_pause', cfg.transportPlaying ? ic.pause : ic.play);
  el.classList.toggle('is-playing', !!cfg.transportPlaying);
}
function syncAutoButton(el, cfg) {
  var wants = isSliderKey(cfg) && sliderAppOf(cfg) === 'fans';
  var btn = el.querySelector('.key-auto-btn');
  el.classList.toggle('has-auto-btn', wants);
  if (!wants) {
    if (btn) btn.remove();
    return;
  }
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'key-auto-btn';
    btn.innerHTML = '<span class="key-auto-label"><i></i>AUTO</span>';
    var stop = function stop(e) {
      e.stopPropagation();
    };
    btn.addEventListener('pointerdown', stop);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('touchstart', stop, {
      passive: true
    });
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (btn.classList.contains('is-unavailable')) return;
      btn.classList.add('is-busy');
      setTimeout(function () {
        return btn.classList.remove('is-busy');
      }, 600);
      wsSend({
        event: 'toggleMute',
        app: 'fans'
      });
    });
    el.appendChild(btn);
  }
  var icon = el.querySelector('.key-icon');
  if (icon && icon.parentNode !== btn) btn.insertBefore(icon, btn.firstChild);
  var available = cfg.autoAvailable !== false;
  btn.classList.toggle('is-on', !!cfg.autoMode && available);
  btn.classList.toggle('is-unavailable', !available);
  btn.setAttribute('aria-pressed', cfg.autoMode ? 'true' : 'false');
  btn.setAttribute('aria-label', cfg.autoMode ? 'Controle automático ligado (toque para manual)' : 'Controle automático desligado (toque para ligar)');
  btn.title = available ? cfg.autoMode ? 'Automático: curvas do CoolerControl' : 'Manual: velocidade fixa do fader' : 'CoolerControl indisponível';
}
function applyKeyAccessibleName(el, cfg) {
  var base = cfg.title || "Tecla ".concat(cfg.index + 1);
  el.setAttribute('aria-label', isSliderKey(cfg) ? "".concat(base, " (volume)") : base);
}
function attachKeyInteraction(el, cfg) {
  var isSlider = isSliderKey(cfg);
  if (isSlider && cfg.badge === 'n/d') {
    el.classList.add('key-unavailable');
    el.setAttribute('aria-disabled', 'true');
    return;
  }
  var wide = isWideKey(cfg);
  var hold = isHoldKey(cfg);
  var appId = sliderAppOf(cfg);
  var pointerDown = false;
  var holdActive = false;
  var dragging = false;
  var dragAxis = null;
  var startX = 0;
  var startY = 0;
  var activePointerId = null;
  var lastSentAt = 0;
  var pendingValue = null;
  var throttleTimer = null;
  var lastShownValue = cfg.sliderValue !== undefined ? cfg.sliderValue : 80;
  var paintPercent = function paintPercent(percent) {
    lastShownValue = percent;
    var fill = el.querySelector('.key-slider-fill');
    if (fill) {
      if (wide) fill.style.width = "".concat(percent, "%");else fill.style.height = "".concat(percent, "%");
    }
    var badge = el.querySelector('.key-badge');
    if (badge) badge.textContent = "".concat(percent, "%");
    el.setAttribute('aria-valuenow', String(percent));
  };
  var flushVolume = function flushVolume() {
    throttleTimer = null;
    if (pendingValue === null) return;
    lastSentAt = Date.now();
    wsSend({
      event: 'setVolume',
      app: appId,
      value: pendingValue
    });
    pendingValue = null;
  };
  var sendVolume = function sendVolume(percent, force) {
    pendingValue = percent;
    var elapsed = Date.now() - lastSentAt;
    if (force || elapsed >= VOLUME_THROTTLE_MS) {
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      flushVolume();
    } else if (!throttleTimer) {
      throttleTimer = setTimeout(flushVolume, VOLUME_THROTTLE_MS - elapsed);
    }
  };
  var percentFromY = function percentFromY(clientY) {
    var rect = (el.querySelector('.key-slider-track') || el).getBoundingClientRect();
    if (!rect.height) return lastShownValue;
    return clamp(Math.round((1 - (clientY - rect.top) / rect.height) * 100), 0, 100);
  };
  var percentFromX = function percentFromX(clientX) {
    var rect = (el.querySelector('.key-slider-track') || el).getBoundingClientRect();
    if (!rect.width) return lastShownValue;
    return clamp(Math.round((clientX - rect.left) / rect.width * 100), 0, 100);
  };
  var releaseHold = function releaseHold() {
    if (!holdActive) return;
    holdActive = false;
    sendKeyEvent('keyUp', cfg.index);
  };
  var _cleanup = function cleanup() {
    pointerDown = false;
    activePointerId = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('blur', onCancel);
    el.classList.remove('is-pressed', 'is-dragging');
    activeDragCleanups.delete(_cleanup);
  };
  var isVolumeDrag = function isVolumeDrag() {
    return isSlider && dragAxis === (wide ? 'x' : 'y');
  };
  var onMove = function onMove(e) {
    if (!pointerDown || e.pointerId !== activePointerId) return;
    if (hold) {
      e.preventDefault();
      return;
    }
    var dx = Math.abs(e.clientX - startX);
    var dy = Math.abs(e.clientY - startY);
    if (!dragging) {
      if (Math.max(dx, dy) <= DRAG_THRESHOLD_PX) return;
      dragging = true;
      dragAxis = dx > dy ? 'x' : 'y';
    }
    if (!isVolumeDrag()) return;
    el.classList.add('is-dragging');
    var percent = wide ? percentFromX(e.clientX) : percentFromY(e.clientY);
    paintPercent(percent);
    sendVolume(percent, false);
    e.preventDefault();
  };
  var onUp = function onUp(e) {
    if (!pointerDown || e.pointerId !== activePointerId) return;
    var wasDragging = dragging;
    var wasVolume = isVolumeDrag();
    _cleanup();
    if (hold) {
      releaseHold();
      return;
    }
    if (wasDragging) {
      if (wasVolume) sendVolume(lastShownValue, true);
      return;
    }
    if (!sendKeyEvent('keyDown', cfg.index)) {
      toast('Sem conexão com o servidor.', {
        type: 'error',
        duration: 2500
      });
      return;
    }
    sendKeyEvent('keyUp', cfg.index);
  };
  var onCancel = function onCancel() {
    if (!pointerDown) return;
    var wasVolume = dragging && isVolumeDrag();
    _cleanup();
    releaseHold();
    if (wasVolume) sendVolume(lastShownValue, true);
  };
  el.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (pointerDown) return;
    pointerDown = true;
    dragging = false;
    dragAxis = null;
    startX = e.clientX;
    startY = e.clientY;
    activePointerId = e.pointerId;
    el.classList.add('is-pressed');
    try {
      el.setPointerCapture(e.pointerId);
    } catch (err) {}
    window.addEventListener('pointermove', onMove, {
      passive: false
    });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
    activeDragCleanups.add(_cleanup);
    e.preventDefault();
    if (hold) {
      if (sendKeyEvent('keyDown', cfg.index)) holdActive = true;else toast('Sem conexão com o servidor.', {
        type: 'error',
        duration: 2500
      });
    }
  });
  el.addEventListener('contextmenu', function (e) {
    return e.preventDefault();
  });
  el.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (hold) {
        if (e.repeat || holdActive) return;
        if (sendKeyEvent('keyDown', cfg.index)) holdActive = true;else toast('Sem conexão com o servidor.', {
          type: 'error',
          duration: 2500
        });
        return;
      }
      if (sendKeyEvent('keyDown', cfg.index)) sendKeyEvent('keyUp', cfg.index);else toast('Sem conexão com o servidor.', {
        type: 'error',
        duration: 2500
      });
      return;
    }
    if (!isSlider) return;
    var delta = 0;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') delta = 5;else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') delta = -5;else if (e.key === 'PageUp') delta = 20;else if (e.key === 'PageDown') delta = -20;else if (e.key === 'Home') delta = -100;else if (e.key === 'End') delta = 100;
    if (!delta) return;
    e.preventDefault();
    var next = clamp(lastShownValue + delta, 0, 100);
    paintPercent(next);
    sendVolume(next, true);
  });
  el.addEventListener('keyup', function (e) {
    if (hold && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      releaseHold();
    }
  });
}
function updateSingleKeyUI(index) {
  var el = document.getElementById("deck-key-".concat(index));
  var cfg = keysData.find(function (k) {
    return k.index === index;
  });
  if (!el || !cfg) return;
  var muted = isKeyMuted(cfg);
  var isSlider = isSliderKey(cfg);
  var pressed = el.classList.contains('is-pressed');
  var draggingNow = el.classList.contains('is-dragging');
  el.className = 'deck-key' + (cfg.active ? ' active-toggle' : '') + (cfg.pulse ? ' key-pulse' : '') + (muted ? ' key-muted' : '') + (isSlider ? ' key-slider' : '') + (pressed ? ' is-pressed' : '') + (draggingNow ? ' is-dragging' : '') + (el.querySelector('.key-slider-track:not(.key-slider-track-h)') ? ' key-tall' : '') + (el.querySelector('.key-slider-track-h') ? ' key-wide' : '') + (cfg.actionId === 'spotify:mixer' ? ' key-mixer' : '') + (cfg.imageFill && cfg.icon ? ' key-image-fill' : '') + (isStatKey(cfg) ? ' key-stat-tile' : '') + (cfg.bgColor && !muted && isDarkColor(cfg.bgColor) ? ' has-dark-bg' : '') + (spanOf(cfg).cols > 1 || spanOf(cfg).rows > 1 ? ' key-span' : '');
  applyKeyAccessibleName(el, cfg);
  if (isStatKey(cfg)) {
    if (!muted) {
      el.style.borderColor = cfg.borderColor || '';
      el.style.backgroundColor = cfg.bgColor || '';
    }
    renderStatContent(el, cfg);
    return;
  }
  if (!muted) {
    el.style.borderColor = cfg.borderColor || '';
    el.style.backgroundColor = cfg.bgColor || '';
  } else {
    el.style.borderColor = '';
    el.style.backgroundColor = '';
  }
  var fill = el.querySelector('.key-slider-fill');
  if (isSlider) {
    if (!fill) {
      fill = document.createElement('div');
      fill.className = 'key-slider-fill';
      el.insertBefore(fill, el.firstChild);
    }
    if (!draggingNow) {
      var val = cfg.sliderValue !== undefined ? cfg.sliderValue : 80;
      if (isWideKey(cfg)) fill.style.width = "".concat(val, "%");else fill.style.height = "".concat(val, "%");
      el.setAttribute('aria-valuenow', String(val));
    }
  } else if (fill) {
    fill.remove();
  }
  var badge = el.querySelector('.key-badge');
  if (cfg.badge) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'key-badge';
      el.appendChild(badge);
    }
    badge.textContent = cfg.badge;
    badge.style.backgroundColor = cfg.badgeColor && !muted ? cfg.badgeColor : '';
  } else if (badge) {
    badge.remove();
  }
  var img = el.querySelector('.key-icon');
  if (cfg.icon) {
    if (!img) {
      img = document.createElement('img');
      img.className = 'key-icon';
      img.alt = '';
      img.draggable = false;
      var titleEl = el.querySelector('.key-title');
      el.insertBefore(img, titleEl || null);
    }
    if (img.src !== cfg.icon) img.src = cfg.icon;
  } else if (img) {
    img.remove();
  }
  var title = el.querySelector('.key-title');
  if (title) {
    title.textContent = cfg.title || '';
    title.style.color = cfg.titleColor && !muted ? cfg.titleColor : '';
  }
  syncAutoButton(el, cfg);
  syncTransport(el, cfg);
  applyIconScale(el, cfg);
}
function sendKeyEvent(type, index) {
  return wsSend({
    event: type,
    keyIndex: index,
    profile: currentProfile
  });
}
var swipe = null;
var activePointers = 0;
var swipeLabelTimer = null;
function showSwipeLabel(text) {
  swipeLabel.textContent = text;
  setHidden(swipeLabel, false);
  swipeLabel.classList.add('is-visible');
  if (swipeLabelTimer) clearTimeout(swipeLabelTimer);
  swipeLabelTimer = setTimeout(function () {
    swipeLabel.classList.remove('is-visible');
    setTimeout(function () {
      return setHidden(swipeLabel, true);
    }, 200);
  }, SWIPE_LABEL_MS);
}
function switchProfileBy(step) {
  var list = (profileList || []).filter(function (p) {
    return p && p.id;
  });
  if (list.length < 2) return false;
  var idx = list.findIndex(function (p) {
    return p.id === currentProfile;
  });
  if (idx < 0) idx = 0;
  var next = list[(idx + step + list.length) % list.length];
  if (!wsSend({
    event: 'switchProfile',
    profile: next.id
  })) {
    toast('Sem conexão com o servidor para trocar o perfil.', {
      type: 'error',
      duration: 2500
    });
    return false;
  }
  showSwipeLabel(next.name || next.id);
  return true;
}
gridWrap.addEventListener('pointerdown', function (e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  activePointers++;
  if (activePointers > 1) {
    swipe = null;
    return;
  }
  swipe = {
    id: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    axis: null
  };
});
gridWrap.addEventListener('pointermove', function (e) {
  if (!swipe || e.pointerId !== swipe.id) return;
  if (swipe.axis) return;
  var dx = Math.abs(e.clientX - swipe.x);
  var dy = Math.abs(e.clientY - swipe.y);
  if (Math.max(dx, dy) > DRAG_THRESHOLD_PX) swipe.axis = dx > dy ? 'x' : 'y';
});
function endSwipe(e, allowSwitch) {
  activePointers = Math.max(0, activePointers - 1);
  if (!swipe || e.pointerId !== swipe.id) return;
  var s = swipe;
  swipe = null;
  if (!allowSwitch || s.axis !== 'x') return;
  if (activePointers > 0) return;
  if (gridEl.querySelector('.deck-key.is-dragging')) return;
  var dx = e.clientX - s.x;
  var dy = Math.abs(e.clientY - s.y);
  if (Math.abs(dx) < SWIPE_MIN_X || dy >= SWIPE_MAX_Y) return;
  switchProfileBy(dx < 0 ? 1 : -1);
}
gridWrap.addEventListener('pointerup', function (e) {
  return endSwipe(e, true);
});
gridWrap.addEventListener('pointercancel', function (e) {
  return endSwipe(e, false);
});
window.addEventListener('blur', function () {
  swipe = null;
  activePointers = 0;
});
function renderConnectionUI() {
  var label = connectionState === 'connected' ? 'Conectado' : connectionState === 'connecting' ? 'Conectando...' : 'Desconectado';
  var addr = serverAddress ? " \xB7 ".concat(serverAddress) : '';
  connDot.dataset.state = connectionState;
  connDot.setAttribute('aria-label', "".concat(label).concat(addr, ". Toque para op\xE7\xF5es"));
  connDot.title = "".concat(label).concat(addr);
  sheetStatusDot.dataset.state = connectionState;
  sheetTitle.textContent = label;
  sheetProfile.textContent = currentProfileName || currentProfile || '—';
  sheetIp.textContent = serverAddress || '—';
}
var sheetFocusReturn = null;
function openSheet() {
  renderConnectionUI();
  sheetFocusReturn = document.activeElement;
  setHidden(sheetBackdrop, false);
  connDot.setAttribute('aria-expanded', 'true');
  document.body.classList.add('sheet-open');
  setTimeout(function () {
    return sheetClose.focus();
  }, 20);
}
function closeSheet() {
  if (sheetBackdrop.hasAttribute('hidden')) return;
  setHidden(sheetBackdrop, true);
  connDot.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('sheet-open');
  if (sheetFocusReturn && typeof sheetFocusReturn.focus === 'function') sheetFocusReturn.focus();
  sheetFocusReturn = null;
  if (fsElement()) showCorner(true);
}
connDot.addEventListener('click', function () {
  if (sheetBackdrop.hasAttribute('hidden')) openSheet();else closeSheet();
});
sheetClose.addEventListener('click', closeSheet);
sheetBackdrop.addEventListener('pointerdown', function (e) {
  if (e.target === sheetBackdrop) closeSheet();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && !sheetBackdrop.hasAttribute('hidden')) closeSheet();
  if (e.key === 'Tab' && !sheetBackdrop.hasAttribute('hidden')) {
    var focusables = _toConsumableArray(sheetBackdrop.querySelectorAll('button:not([disabled]), a[href]')).filter(function (el) {
      return el.offsetParent !== null;
    });
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});
function applyTheme(theme) {
  var light = theme === 'light';
  if (light) document.documentElement.setAttribute('data-theme', 'light');else document.documentElement.removeAttribute('data-theme');
  var meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute('content', light ? 'light dark' : 'dark light');
  var _iterator3 = _createForOfIteratorHelper(themeSeg.querySelectorAll('button')),
    _step3;
  try {
    for (_iterator3.s(); !(_step3 = _iterator3.n()).done;) {
      var b = _step3.value;
      b.setAttribute('aria-pressed', b.dataset.themeValue === (light ? 'light' : 'dark') ? 'true' : 'false');
    }
  } catch (err) {
    _iterator3.e(err);
  } finally {
    _iterator3.f();
  }
}
function applyFontSize(size) {
  var s = size === 's' || size === 'l' ? size : 'm';
  if (s === 'm') document.documentElement.removeAttribute('data-font');else document.documentElement.setAttribute('data-font', s);
  var _iterator4 = _createForOfIteratorHelper(fontSeg.querySelectorAll('button')),
    _step4;
  try {
    for (_iterator4.s(); !(_step4 = _iterator4.n()).done;) {
      var b = _step4.value;
      b.setAttribute('aria-pressed', b.dataset.fontValue === s ? 'true' : 'false');
    }
  } catch (err) {
    _iterator4.e(err);
  } finally {
    _iterator4.f();
  }
}
themeSeg.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-theme-value]');
  if (!btn) return;
  applyTheme(btn.dataset.themeValue);
  storageSet(THEME_KEY, btn.dataset.themeValue);
});
fontSeg.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-font-value]');
  if (!btn) return;
  applyFontSize(btn.dataset.fontValue);
  storageSet(FONT_KEY, btn.dataset.fontValue);
});
var AWAKE_KEY = 'matdeck-awake';
var AWAKE_WATCHDOG_MS = 20000;
var awakeWanted = storageGet(AWAKE_KEY) !== 'off';
var wakeLock = null;
var noSleep = null;
var awakeActive = false;
function noSleepVideoPlaying() {
  var v = noSleep && noSleep.noSleepVideo;
  return !!v && !v.paused && !v.ended && v.readyState > 0;
}
function awakeHeld() {
  return !!wakeLock || noSleepVideoPlaying();
}
function setAwakeActive(on) {
  awakeActive = !!on;
  if (!awakeStatus) return;
  if (!awakeWanted) awakeStatus.textContent = '';else awakeStatus.textContent = awakeActive ? 'Ativo: a tela não escurece.' : 'Aguardando um toque na tela para ativar…';
}
function enableAwake() {
  return _enableAwake.apply(this, arguments);
}
function _enableAwake() {
  _enableAwake = _asyncToGenerator(_regenerator().m(function _callee2() {
    var v, _t2, _t3;
    return _regenerator().w(function (_context2) {
      while (1) switch (_context2.p = _context2.n) {
        case 0:
          if (!(!awakeWanted || document.visibilityState !== 'visible')) {
            _context2.n = 1;
            break;
          }
          return _context2.a(2, false);
        case 1:
          if (!('wakeLock' in navigator && navigator.wakeLock && typeof navigator.wakeLock.request === 'function')) {
            _context2.n = 6;
            break;
          }
          _context2.p = 2;
          if (wakeLock) {
            _context2.n = 4;
            break;
          }
          _context2.n = 3;
          return navigator.wakeLock.request('screen');
        case 3:
          wakeLock = _context2.v;
          wakeLock.addEventListener('release', function () {
            wakeLock = null;
            setAwakeActive(awakeHeld());
          });
        case 4:
          setAwakeActive(true);
          return _context2.a(2, true);
        case 5:
          _context2.p = 5;
          _t2 = _context2.v;
        case 6:
          if (!(typeof NoSleep !== 'function')) {
            _context2.n = 7;
            break;
          }
          setAwakeActive(false);
          return _context2.a(2, false);
        case 7:
          _context2.p = 7;
          if (!noSleep) {
            noSleep = new NoSleep();
            v = noSleep.noSleepVideo;
            if (v) {
              v.muted = true;
              v.setAttribute('muted', '');
              v.setAttribute('loop', '');
              v.addEventListener('pause', function () {
                return setAwakeActive(awakeHeld());
              });
              v.addEventListener('playing', function () {
                return setAwakeActive(true);
              });
            }
          }
          if (noSleepVideoPlaying()) {
            _context2.n = 8;
            break;
          }
          _context2.n = 8;
          return noSleep.enable();
        case 8:
          setAwakeActive(noSleep.noSleepVideo ? noSleepVideoPlaying() : !!noSleep.isEnabled);
          _context2.n = 10;
          break;
        case 9:
          _context2.p = 9;
          _t3 = _context2.v;
          setAwakeActive(false);
        case 10:
          return _context2.a(2, awakeActive);
      }
    }, _callee2, null, [[7, 9], [2, 5]]);
  }));
  return _enableAwake.apply(this, arguments);
}
function disableAwake() {
  if (wakeLock) {
    try {
      wakeLock.release();
    } catch (e) {}
    wakeLock = null;
  }
  if (noSleep) {
    try {
      noSleep.disable();
    } catch (e) {}
  }
  setAwakeActive(false);
}
function applyAwakeUI() {
  var _iterator5 = _createForOfIteratorHelper(awakeSeg.querySelectorAll('[data-awake-value]')),
    _step5;
  try {
    for (_iterator5.s(); !(_step5 = _iterator5.n()).done;) {
      var b = _step5.value;
      b.setAttribute('aria-pressed', b.dataset.awakeValue === 'on' === awakeWanted ? 'true' : 'false');
    }
  } catch (err) {
    _iterator5.e(err);
  } finally {
    _iterator5.f();
  }
  setAwakeActive(awakeActive);
}
function armAwakeOnGesture() {
  var retry = function retry() {
    if (awakeWanted && !awakeHeld()) enableAwake();
  };
  for (var _i5 = 0, _arr4 = ['pointerup', 'touchend', 'click', 'keydown']; _i5 < _arr4.length; _i5++) {
    var ev = _arr4[_i5];
    document.addEventListener(ev, retry, {
      passive: true
    });
  }
}
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && awakeWanted) enableAwake();
});
setInterval(function () {
  if (awakeWanted && document.visibilityState === 'visible' && !awakeHeld()) enableAwake();
}, AWAKE_WATCHDOG_MS);
var awakeSeg = $('awake-seg');
var awakeStatus = $('awake-status');
awakeSeg.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-awake-value]');
  if (!btn) return;
  awakeWanted = btn.dataset.awakeValue === 'on';
  storageSet(AWAKE_KEY, awakeWanted ? 'on' : 'off');
  applyAwakeUI();
  if (awakeWanted) enableAwake();else disableAwake();
  toast(awakeWanted ? 'A tela vai ficar acesa enquanto o deck estiver aberto.' : 'O tablet volta a apagar a tela normalmente.', {
    type: 'info',
    duration: 2500
  });
});
applyAwakeUI();
armAwakeOnGesture();
if (awakeWanted) enableAwake();
var CORNER_HIDE_MS = 3000;
var cornerHideTimer = null;
function showCorner(autoHide) {
  document.body.classList.remove('corner-hidden');
  if (cornerHideTimer) {
    clearTimeout(cornerHideTimer);
    cornerHideTimer = null;
  }
  if (autoHide) cornerHideTimer = setTimeout(function () {
    if (fsElement() && !sheetOpen()) document.body.classList.add('corner-hidden');
  }, CORNER_HIDE_MS);
}
function sheetOpen() {
  return connDot.getAttribute('aria-expanded') === 'true';
}
$('corner-hotzone').addEventListener('pointerdown', function (e) {
  e.preventDefault();
  showCorner(true);
});
function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}
function fsSupported() {
  var el = document.documentElement;
  return typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function';
}
function requestFs() {
  var el = document.documentElement;
  if (typeof el.requestFullscreen === 'function') return el.requestFullscreen();
  try {
    el.webkitRequestFullscreen();
    return Promise.resolve();
  } catch (e) {
    return Promise.reject(e);
  }
}
function exitFs() {
  if (typeof document.exitFullscreen === 'function') return document.exitFullscreen().catch(function () {});
  try {
    if (typeof document.webkitExitFullscreen === 'function') document.webkitExitFullscreen();
  } catch (e) {}
  return Promise.resolve();
}
function refreshFullscreenLabel() {
  var supported = fsSupported();
  btnFullscreen.hidden = !supported;
  btnFullscreenCorner.hidden = !supported;
  var on = !!fsElement();
  btnFullscreenLabel.textContent = on ? 'Sair da tela cheia' : 'Tela cheia';
  btnFullscreenCorner.setAttribute('aria-pressed', on ? 'true' : 'false');
  btnFullscreenCorner.setAttribute('aria-label', on ? 'Sair da tela cheia' : 'Tela cheia');
  document.body.classList.toggle('is-fullscreen', on);
  showCorner(on);
}
function lockLandscape() {
  var so = screen.orientation;
  if (!so || typeof so.lock !== 'function') return Promise.resolve(false);
  return so.lock('landscape').then(function () {
    return true;
  }).catch(function () {
    return false;
  });
}
function unlockOrientation() {
  var so = screen.orientation;
  if (so && typeof so.unlock === 'function') {
    try {
      so.unlock();
    } catch (e) {}
  }
}
function toggleFullscreen() {
  if (!fsSupported()) {
    toast('Tela cheia não disponível neste navegador.', {
      type: 'warning'
    });
    return;
  }
  if (!fsElement()) {
    requestFs().then(lockLandscape).catch(function () {
      return toast('Tela cheia não disponível neste navegador.', {
        type: 'warning'
      });
    });
  } else {
    unlockOrientation();
    exitFs();
  }
}
if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) lockLandscape();
btnFullscreen.addEventListener('click', toggleFullscreen);
btnFullscreenCorner.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', refreshFullscreenLabel);
document.addEventListener('webkitfullscreenchange', refreshFullscreenLabel);
function pollStatus() {
  return _pollStatus.apply(this, arguments);
}
function _pollStatus() {
  _pollStatus = _asyncToGenerator(_regenerator().m(function _callee3() {
    var res, data;
    return _regenerator().w(function (_context3) {
      while (1) switch (_context3.n) {
        case 0:
          _context3.n = 1;
          return apiFetch('/api/status');
        case 1:
          res = _context3.v;
          if (!(!res.ok || !res.data)) {
            _context3.n = 2;
            break;
          }
          return _context3.a(2);
        case 2:
          data = res.data;
          if (data.ip) {
            serverAddress = "".concat(data.ip, ":").concat(data.port);
            renderConnectionUI();
          }
          if (data.profile && data.profile !== currentProfile) {
            currentProfile = data.profile;
            renderConnectionUI();
          }
          if (data.hardware && !hardwareHud.hasAttribute('hidden')) updateHardwareHud(data.hardware);
        case 3:
          return _context3.a(2);
      }
    }, _callee3);
  }));
  return _pollStatus.apply(this, arguments);
}
var statusTimer = null;
var pairSession = null;
var pairTimer = null;
function startSession() {
  return _startSession.apply(this, arguments);
}
function _startSession() {
  _startSession = _asyncToGenerator(_regenerator().m(function _callee4() {
    var res;
    return _regenerator().w(function (_context4) {
      while (1) switch (_context4.n) {
        case 0:
          if (wsReconnectTimer) {
            clearTimeout(wsReconnectTimer);
            wsReconnectTimer = null;
          }
          _context4.n = 1;
          return apiFetch('/api/session');
        case 1:
          res = _context4.v;
          if (!(res.ok && res.data && res.data.role === 'guest')) {
            _context4.n = 2;
            break;
          }
          showPairing();
          return _context4.a(2);
        case 2:
          hidePairing();
          initWebSocket();
          pollStatus();
          if (!statusTimer) statusTimer = setInterval(pollStatus, 5000);
        case 3:
          return _context4.a(2);
      }
    }, _callee4);
  }));
  return _startSession.apply(this, arguments);
}
function setPairStatus(text, kind) {
  pairStatus.textContent = text || '';
  pairStatus.className = 'pair-status' + (kind ? ' is-' + kind : '');
}
function showPairing() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  document.body.classList.add('is-offline');
  setHidden(deckOverlayMain, true);
  setHidden(pairCard, false);
  setHidden(deckOverlay, false);
  gridEl.setAttribute('aria-busy', 'true');
  pairPin.value = '';
  pairStart();
}
function hidePairing() {
  if (pairTimer) {
    clearTimeout(pairTimer);
    pairTimer = null;
  }
  pairSession = null;
  setHidden(pairCard, true);
  setHidden(deckOverlayMain, false);
}
function pairRetryIn(ms) {
  if (pairTimer) clearTimeout(pairTimer);
  pairTimer = setTimeout(pairStart, Math.max(1000, ms));
}
function pairStart() {
  return _pairStart.apply(this, arguments);
}
function _pairStart() {
  _pairStart = _asyncToGenerator(_regenerator().m(function _callee5() {
    var res, d, wait;
    return _regenerator().w(function (_context5) {
      while (1) switch (_context5.n) {
        case 0:
          if (pairTimer) {
            clearTimeout(pairTimer);
            pairTimer = null;
          }
          pairSession = null;
          pairSubmit.disabled = true;
          setPairStatus('Pedindo um PIN ao computador…');
          _context5.n = 1;
          return apiFetch('/api/pair/start', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: '{}'
          });
        case 1:
          res = _context5.v;
          d = res.data || {};
          if (!(res.ok && d.id)) {
            _context5.n = 2;
            break;
          }
          pairSession = d.id;
          pairSubmit.disabled = false;
          setPairStatus('O PIN está no gerenciador do computador. Vale por ' + Math.round((d.ttlMs || 120000) / 60000) + ' min.');
          pairRetryIn((d.ttlMs || 120000) + 500);
          try {
            pairPin.focus();
          } catch (e) {}
          return _context5.a(2);
        case 2:
          if (!(res.status === 429)) {
            _context5.n = 3;
            break;
          }
          wait = d.retryAfterMs || 30000;
          setPairStatus('Muitas tentativas. Um PIN novo em ' + Math.ceil(wait / 1000) + ' s.', 'error');
          pairRetryIn(wait + 300);
          return _context5.a(2);
        case 3:
          if (!(res.status === 400)) {
            _context5.n = 4;
            break;
          }
          hidePairing();
          startSession();
          return _context5.a(2);
        case 4:
          setPairStatus(res.status ? d.error || 'O computador recusou o pedido. Tentando de novo…' : 'Sem resposta do computador. Tentando de novo…', 'error');
          pairRetryIn(3000);
        case 5:
          return _context5.a(2);
      }
    }, _callee5);
  }));
  return _pairStart.apply(this, arguments);
}
function pairVerify(_x3) {
  return _pairVerify.apply(this, arguments);
}
function _pairVerify() {
  _pairVerify = _asyncToGenerator(_regenerator().m(function _callee6(e) {
    var pin, res, d, wait;
    return _regenerator().w(function (_context6) {
      while (1) switch (_context6.n) {
        case 0:
          if (e && e.preventDefault) e.preventDefault();
          pin = String(pairPin.value || '').replace(/\D/g, '');
          if (!(pin.length !== 4)) {
            _context6.n = 1;
            break;
          }
          setPairStatus('Digite os 4 dígitos do PIN.', 'error');
          return _context6.a(2);
        case 1:
          if (pairSession) {
            _context6.n = 2;
            break;
          }
          pairStart();
          return _context6.a(2);
        case 2:
          pairSubmit.disabled = true;
          setPairStatus('Conferindo…');
          _context6.n = 3;
          return apiFetch('/api/pair/verify', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              id: pairSession,
              pin: pin
            })
          });
        case 3:
          res = _context6.v;
          d = res.data || {};
          if (!(res.ok && d.success)) {
            _context6.n = 4;
            break;
          }
          if (pairTimer) {
            clearTimeout(pairTimer);
            pairTimer = null;
          }
          setPairStatus('Conectado! Carregando o deck…', 'ok');
          setTimeout(function () {
            return location.reload();
          }, 400);
          return _context6.a(2);
        case 4:
          pairPin.value = '';
          if (res.status === 401) {
            setPairStatus('PIN incorreto. ' + (d.attemptsLeft || 0) + ' tentativa(s) restante(s).', 'error');
            pairSubmit.disabled = false;
            try {
              pairPin.focus();
            } catch (e2) {}
          } else if (res.status === 410) {
            setPairStatus('Esse PIN venceu. Pedindo um novo…', 'error');
            pairRetryIn(600);
          } else if (res.status === 429) {
            wait = d.retryAfterMs || 30000;
            setPairStatus('Muitas tentativas. Um PIN novo em ' + Math.ceil(wait / 1000) + ' s.', 'error');
            pairRetryIn(wait + 300);
          } else if (res.status === 400) {
            hidePairing();
            startSession();
          } else {
            setPairStatus(d.error || 'Não foi possível conferir o PIN. Tente de novo.', 'error');
            pairSubmit.disabled = false;
          }
        case 5:
          return _context6.a(2);
      }
    }, _callee6);
  }));
  return _pairVerify.apply(this, arguments);
}
pairForm.addEventListener('submit', pairVerify);
pairPin.addEventListener('input', function () {
  if (!pairSubmit.disabled && String(pairPin.value || '').replace(/\D/g, '').length === 4) pairVerify();
});
renderSkeletonGrid();
applyTheme(storageGet(THEME_KEY) === 'light' ? 'light' : 'dark');
applyFontSize(storageGet(FONT_KEY) || 'm');
refreshFullscreenLabel();
var VIEWPORT_RETRY_MS = 500;
var viewportRetryTimer = null;
var viewportApplied = 0;
function pickViewportHeight(win, scr) {
  var vals = [win && win.innerHeight, win && win.document && win.document.documentElement && win.document.documentElement.clientHeight];
  var h = 0;
  for (var i = 0; i < vals.length; i++) {
    var v = Number(vals[i]);
    if (isFinite(v) && v > h) h = v;
  }
  var side = scr && isFinite(Number(scr.width)) && isFinite(Number(scr.height)) ? Math.min(Number(scr.width), Number(scr.height)) : 0;
  var floor = side > 0 ? side * 0.4 : 200;
  return h >= floor ? Math.round(h) : null;
}
function syncViewportHeight() {
  try {
    var h = pickViewportHeight(window, typeof screen !== 'undefined' ? screen : null);
    if (h === null) {
      if (!viewportRetryTimer) viewportRetryTimer = setTimeout(function () {
        viewportRetryTimer = null;
        syncViewportHeight();
      }, VIEWPORT_RETRY_MS);
      return;
    }
    if (h === viewportApplied) return;
    viewportApplied = h;
    document.documentElement.style.setProperty('--app-h', h + 'px');
  } catch (e) {}
}
syncViewportHeight();
window.addEventListener('resize', syncViewportHeight);
window.addEventListener('orientationchange', function () {
  setTimeout(syncViewportHeight, 300);
});
window.addEventListener('pageshow', function () {
  syncViewportHeight();
  setTimeout(syncViewportHeight, 300);
});
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible') {
    syncViewportHeight();
    setTimeout(syncViewportHeight, 300);
  }
});
setInterval(syncViewportHeight, 2000);
startSession();
window.MATDECK_APP_BOOTED = true;
