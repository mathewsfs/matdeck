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
