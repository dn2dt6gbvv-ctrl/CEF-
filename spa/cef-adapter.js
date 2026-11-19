/* cef-adapter.js — мост между SPA «AMAZING» (CEF-ALL-IN-ONE) и плагином samp-cef (zottce).
 *
 * ЧТО ДАЁТ ПЛАГИН (renderer/src/main.rs):  window.cef = { version, on(name, cb), off(name, cb), emit(name, ...args), hide(bool), set_focus(bool) }
 *   - Pawn cef_emit_event(...)  -> cb(arg1, arg2, ...)   (строки/числа, JSON приходит ОДНОЙ строкой)
 *   - cef.emit(name, ...args)   -> Pawn cef_subscribe-колбэк получает аргументы одной строкой через пробел
 *
 * ЧТО ЖДЁТ SPA (cefService, chunk-RGWRUSEG.js):  cef.on(name, cb(obj)), cef.trigger(name, obj), cef.queryKeyboardLayout(),
 *   cef.allowPassWindowMessages({...}), cef.setBlurRegion/removeBlurRegion, глобальные cefGpu, cefModel, cefModelPed, cefModelVehicle.
 *
 * Адаптер: trigger(name,obj) -> emit(name, JSON.stringify(obj));  on(name,cb) -> cb(JSON.parse(str)).
 * Подключается ПЕРВЫМ <script> в <head> index.html (до module-скриптов).
 */
(function () {
  'use strict';
  if (window.__CEF_ADAPTER__) return;
  window.__CEF_ADAPTER__ = { version: '1.27', plugin: false, log: [] };

  /* Полифиллы для Chromium 89 (samp-cef v1.4.1): Object.hasOwn (Chrome 93), Array.prototype.at (92), structuredClone (98). */
  if (typeof Object.hasOwn !== 'function') { Object.hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(Object(o), k); }; }
  if (typeof Array.prototype.at !== 'function') { Array.prototype.at = function (i) { i = Math.trunc(i) || 0; if (i < 0) i += this.length; return (i < 0 || i >= this.length) ? undefined : this[i]; }; }
  if (typeof String.prototype.at !== 'function') { String.prototype.at = function (i) { i = Math.trunc(i) || 0; if (i < 0) i += this.length; return (i < 0 || i >= this.length) ? undefined : this.charAt(i); }; }
  if (typeof window.structuredClone !== 'function') { window.structuredClone = function (v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }; }





  /* Раскладка клавиатуры. Плагин её не сообщает, поэтому определяем по вводимым символам:
     кириллица -> RU, латиница -> EN. Без этого в поле ввода всегда висело "RU". */
  (function autoKeyboardLayout() {
    var current = 'RU';
    function apply(lang) {
      if (lang === current) return;
      current = lang;
      window.__CEF_ADAPTER__.layout = lang;
      var ce;
      try { ce = new CustomEvent('onKeyboardLayoutChange', { detail: lang }); }
      catch (e) { ce = document.createEvent('CustomEvent'); ce.initCustomEvent('onKeyboardLayoutChange', false, false, lang); }
      window.dispatchEvent(ce);
    }
    document.addEventListener('keypress', function (e) {
      var ch = e.key;
      if (!ch || ch.length !== 1) return;
      if (/[а-яёА-ЯЁ]/.test(ch)) apply('RU');
      else if (/[a-zA-Z]/.test(ch)) apply('EN');
    }, true);
    /* Alt+Shift и Ctrl+Shift переключают раскладку в Windows: помечаем смену заранее */
    document.addEventListener('keyup', function (e) {
      if ((e.key === 'Shift' && (e.altKey || e.ctrlKey)) ||
          ((e.key === 'Alt' || e.key === 'Control') && e.shiftKey)) {
        apply(current === 'RU' ? 'EN' : 'RU');
      }
    }, true);
  })();

  /* SPA дергает внешний API (новости, блог). В игре страница живёт на file://, поэтому такие
     запросы всегда падают и сыплют в консоль "Response is missing". Отвечаем пустыми данными. */
  (function blockRemoteApi() {
    var isRemote = function (u) { return /^https?:\/\//i.test(String(u || '')); };
    var f = window.fetch;
    if (f) {
      window.fetch = function (input, init) {
        var url = (typeof input === 'string') ? input : (input && input.url);
        if (isRemote(url) && typeof Response === 'function') {
          return Promise.resolve(new Response(JSON.stringify({ code: 'OK', response: [] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return f.apply(this, arguments);
      };
    }
    var XHR = window.XMLHttpRequest;
    if (XHR) {
      var open = XHR.prototype.open, send = XHR.prototype.send;
      XHR.prototype.open = function (m, url) { this.__remote = isRemote(url); return open.apply(this, arguments); };
      XHR.prototype.send = function () {
        var x = this;
        if (!x.__remote) return send.apply(x, arguments);
        var body = '{"code":"OK","response":[]}';
        var props = { readyState: 4, status: 200, statusText: 'OK', response: body, responseText: body, responseURL: '' };
        for (var k in props) { try { Object.defineProperty(x, k, { value: props[k], configurable: true }); } catch (e) { } }
        setTimeout(function () {
          try { x.dispatchEvent(new Event('readystatechange')); } catch (e) { }
          try { x.dispatchEvent(new ProgressEvent('load')); } catch (e) { }
          try { x.dispatchEvent(new ProgressEvent('loadend')); } catch (e) { }
        }, 0);
      };
    }
  })();

  /* file://: картинки/маски, назначаемые в рантайме (иконки банка и т.п.), блокируются CORS.
     Подменяем url(assets/*.svg) на data: из карты window.__SVG_INLINE__. */
  (function svgStyleShim() {
    if (location.protocol !== 'file:') return;
    function dataUri(path) {
      var map = window.__SVG_INLINE__; if (!map) return null;
      var u = String(path).replace(/^["']|["']$/g, '').split('?')[0].split('#')[0];
      var i = u.indexOf('assets/'); if (i < 0) return null;
      var key = u.slice(i);
      if (!Object.prototype.hasOwnProperty.call(map, key)) return null;
      try { return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(map[key]))); }
      catch (e) { return null; }
    }
    function fixValue(v) {
      if (typeof v !== 'string' || v.indexOf('assets/') < 0 || v.indexOf('url(') < 0) return v;
      return v.replace(/url\((['"]?)([^)'"]+)\1\)/g, function (all, q, path) {
        var d = dataUri(path); return d ? 'url("' + d + '")' : all;
      });
    }
    var proto = window.CSSStyleDeclaration && window.CSSStyleDeclaration.prototype;
    if (proto && proto.setProperty) {
      var sp = proto.setProperty;
      proto.setProperty = function (n, v, p) { return sp.call(this, n, fixValue(v), p); };
    }
    var setAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (n, v) {
      if (n === 'style') v = fixValue(v);
      if ((n === 'src' || n === 'href') && typeof v === 'string' && /assets\/.+\.svg$/.test(v)) {
        var d = dataUri(v); if (d) v = d;
      }
      return setAttr.call(this, n, v);
    };
    try {
      var imgSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      if (imgSrc && imgSrc.set) {
        Object.defineProperty(HTMLImageElement.prototype, 'src', {
          configurable: true, enumerable: imgSrc.enumerable, get: imgSrc.get,
          set: function (v) { var d = (typeof v === 'string' && /assets\/.+\.svg$/.test(v)) ? dataUri(v) : null; return imgSrc.set.call(this, d || v); }
        });
      }
    } catch (e) { }
  })();

  /* file:// без --allow-file-access-from-files (v1.4.1): XHR/fetch к file:// блокируется CORS.
     Если подключён svg-inline.js (window.__SVG_INLINE__), отдаём SVG-иконки из памяти. */
  (function installFileXhrShim() {
    if (location.protocol !== 'file:') return;
    function inlineFor(url) {
      var map = window.__SVG_INLINE__; if (!map) return null;
      var u = String(url).split('?')[0].split('#')[0];
      var i = u.indexOf('assets/'); if (i < 0) return null;
      var key = u.slice(i);
      return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
    }
    var XHR = window.XMLHttpRequest;
    if (XHR) {
      var open = XHR.prototype.open, send = XHR.prototype.send;
      XHR.prototype.open = function (m, url) { this.__inl = inlineFor(url); return open.apply(this, arguments); };
      XHR.prototype.send = function () {
        var x = this, body = x.__inl;
        if (body == null) return send.apply(x, arguments);
        var props = { readyState: 4, status: 200, statusText: 'OK', response: body, responseText: body, responseURL: '' };
        for (var k in props) { try { Object.defineProperty(x, k, { value: props[k], configurable: true }); } catch (e) { } }
        x.getAllResponseHeaders = function () { return 'content-type: image/svg+xml\r\n'; };
        x.getResponseHeader = function (h) { return /content-type/i.test(h) ? 'image/svg+xml' : null; };
        setTimeout(function () {
          try { x.dispatchEvent(new Event('readystatechange')); } catch (e) { }
          try { x.dispatchEvent(new ProgressEvent('load')); } catch (e) { }
          try { x.dispatchEvent(new ProgressEvent('loadend')); } catch (e) { }
        }, 0);
      };
    }
    var f = window.fetch;
    if (f) {
      window.fetch = function (input, init) {
        var url = (typeof input === 'string') ? input : (input && input.url);
        var body = inlineFor(url);
        if (body != null && typeof Response === 'function') return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'image/svg+xml' } }));
        return f.apply(this, arguments);
      };
    }
  })();

  var plugin = (typeof window.cef === 'object' && window.cef && typeof window.cef.on === 'function' && typeof window.cef.emit === 'function') ? window.cef : null;
  window.__CEF_ADAPTER__.plugin = !!plugin;

  function parseArg(a) {
    if (typeof a !== 'string') return a;
    var s = a.trim();
    if (!s) return a;
    var c = s.charAt(0);
    if (c === '{' || c === '[') { try { return JSON.parse(s); } catch (e) { return a; } }
    if (s === 'true') return true;
    if (s === 'false') return false;
    return a;
  }
  function toArg(d) {
    if (d === undefined || d === null) return '{}';
    if (typeof d === 'string') return d;
    try { return JSON.stringify(d); } catch (e) { return String(d); }
  }

  var wrapped = []; // [name, cb, wrappedFn]
  var localHandlers = {}; // режим без плагина (превью в браузере)

  var api = {
    version: plugin ? plugin.version : 'adapter-standalone',
    isReady: true,
    on: function (name, cb) {
      if (typeof name === 'object' && name) { cb = name.callback || name.cb; name = name.event || name.name; }
      if (typeof cb !== 'function') return;
      var w = function () {
        var args = Array.prototype.slice.call(arguments);
        var data = args.length === 0 ? undefined : (args.length === 1 ? parseArg(args[0]) : args.map(parseArg));
        if (name === 'cef_app_set_config') {
          if (window.__CEF_ADAPTER__.configApplied) return;   // режим ставится один раз
          window.__CEF_ADAPTER__.configApplied = true;
        }
        /* chips/credits → вкладка «C» рядом с «Амазингов». Не отдаём SPA. */
        if (typeof data !== 'object' || !data || Array.isArray(data)) {
          if (name === 'perks_update') data = {};
          if (name === 'cef_prize_menu_show') data = {};
        }
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          if (name === 'cef_account_balances_update') {
            try { delete data.chips; delete data.credits; delete data.amazings; delete data.e; } catch (e) { }
          }
          if (name === 'update_account_stats' && data.general) {
            try {
              delete data.general.donateMoney;
              delete data.general.donate;
              delete data.general.amazings;
              delete data.general.credits;
              delete data.general.chips;
            } catch (e) { }
          }
          if (name === 'perks_update') {
            try {
              var incoming = Array.isArray(data.perks) ? data.perks : [];
              var filled = [];
              for (var i = 0; i < 65; i++) {
                var src = incoming[i];
                if (!src || typeof src !== 'object') {
                  src = null;
                  for (var j = 0; j < incoming.length; j++) {
                    if (incoming[j] && incoming[j].id === i) { src = incoming[j]; break; }
                  }
                }
                src = src || {};
                var on = src.isActive === true || src.isActive === 1 || src.isActive === 'true';
                filled.push({
                  id: i,
                  level: parseInt(src.level, 10) || 0,
                  maxLevel: parseInt(src.maxLevel, 10) || 1,
                  isActive: on,
                  priceCoins: parseInt(src.priceCoins, 10) || 5
                });
              }
              data.perks = filled;
              var esi = data.extraSlotInfo;
              if (!esi || typeof esi !== 'object') esi = {};
              data.extraSlotInfo = {
                used: parseInt(esi.used, 10) || 0,
                total: parseInt(esi.total, 10) || 3,
                priceCoins: parseInt(esi.priceCoins, 10) || 1000,
                priceMoney: parseInt(esi.priceMoney, 10) || 5000000
              };
              if (typeof data.myQuestCoins !== 'number') data.myQuestCoins = 0;
              if (typeof data.points !== 'number') data.points = 0;
              if (typeof data.availablePoints !== 'number') data.availablePoints = 0;
            } catch (e) { }
          }
          if (name === 'cef_prize_menu_show') {
            try {
              var cats = Array.isArray(data.categories) ? data.categories : [];
              var names = ['Транспорт', 'Аксессуары', 'Оружие', 'Скины', 'Прочее'];
              if (!cats.length) {
                cats = names.map(function (n, i) { return { id: i, name: n, title: n, available: 0, count: 0 }; });
              }
              data.categories = cats.map(function (c, i) {
                c = c && typeof c === 'object' ? c : {};
                var av = c.available;
                if (av && typeof av === 'object') av = (typeof av.count === 'number' ? av.count : 0);
                if (typeof av !== 'number' || isNaN(av)) av = 0;
                var cnt = c.count;
                if (typeof cnt !== 'number' || isNaN(cnt)) cnt = av;
                return {
                  id: (c.id != null) ? c.id : i,
                  name: c.name || c.title || names[i] || ('Категория ' + i),
                  title: c.title || c.name || names[i] || '',
                  available: av,
                  count: cnt
                };
              });
              if (data.prizes && !Array.isArray(data.prizes)) data.prizes = [];
            } catch (e) { }
          }
          if (name === 'cef_prize_menu_upd_category') {
            try {
              var av2 = data.available;
              if (av2 && typeof av2 === 'object') av2 = (typeof av2.count === 'number' ? av2.count : 0);
              if (typeof av2 !== 'number' || isNaN(av2)) av2 = 0;
              data.available = av2;
              if (typeof data.count !== 'number') data.count = av2;
            } catch (e) { }
          }
        }
        try { cb(data); } catch (e) { try { console.error('[cef-adapter] handler ' + name + ':', e); } catch (_) { } }
      };
      wrapped.push([name, cb, w]);
      if (plugin) plugin.on(name, w); else (localHandlers[name] = localHandlers[name] || []).push(w);
    },
    off: function (name, cb) {
      for (var i = wrapped.length - 1; i >= 0; i--) {
        if (wrapped[i][0] === name && (!cb || wrapped[i][1] === cb)) {
          if (plugin) { try { plugin.off(name, wrapped[i][2]); } catch (e) { } }
          else if (localHandlers[name]) localHandlers[name] = localHandlers[name].filter(function (f) { return f !== wrapped[i][2]; });
          wrapped.splice(i, 1);
        }
      }
    },
    trigger: function (name, data) {
      if (typeof name === 'object' && name) { data = name.data; name = name.event || name.name; }
      /* Режим приложения. to3[DEV] пуст: в DEV не грузится НИ ОДИН модуль (ни HUD, ни банк,
         ни магазин). Полный набор - только в REMOTE(1). SPA сам ставит DEV через 100 мс после
         cef_app_started, поэтому отвечаем синхронно и раньше него. */
      if (name === 'cef_app_started' && !window.__CEF_ADAPTER__.configSent) {
        window.__CEF_ADAPTER__.configSent = true;
        try { dispatchLocal('cef_app_set_config', { mode: 1, theme: 'dark' }); } catch (e) { }
      }
      var s = toArg(data);
      if (plugin) { try { plugin.emit(name, s); } catch (e) { try { console.error('[cef-adapter] emit ' + name + ':', e); } catch (_) { } } }
      else { window.__CEF_ADAPTER__.log.push(['send', name, s]); if (window.__CEF_STANDALONE_ON_TRIGGER) window.__CEF_STANDALONE_ON_TRIGGER(name, data); }
    },
    emit: function (name, data) {
      var args = Array.prototype.slice.call(arguments, 1);
      if (args.length === 1 && args[0] !== null && typeof args[0] === 'object')
        args[0] = (typeof toArg === 'function') ? toArg(args[0]) : JSON.stringify(args[0]);
      if (plugin) return plugin.emit.apply(plugin, [name].concat(args));
      window.__CEF_ADAPTER__.log.push(['send', name].concat(args));
    },
    hide: function (v) { if (plugin && plugin.hide) try { plugin.hide(v); } catch (e) { } },
    set_focus: function (v) { if (plugin && plugin.set_focus) try { plugin.set_focus(v); } catch (e) { } },
    queryKeyboardLayout: function () {
      // у плагина нет запроса раскладки — отвечаем сразу; Pawn может прислать cef_host_keyboard_layout {layout:"RU"}
      setTimeout(function () { dispatchLayout(window.__CEF_ADAPTER__.layout || 'RU'); }, 0);
    },
    allowPassWindowMessages: function () { },
    setBlurRegion: function () { },
    removeBlurRegion: function () { },
    setInputFocus: function () { },
    resizeView: function () { },
    openDevTools: function () { },
    closeDevTools: function () { }
  };

  function dispatchLayout(l) {
    var ce;
    try { ce = new CustomEvent('onKeyboardLayoutChange', { detail: l }); }
    catch (e) { ce = document.createEvent('CustomEvent'); ce.initCustomEvent('onKeyboardLayoutChange', false, false, l); }
    window.dispatchEvent(ce);
  }

  // хост -> страница (для standalone-превью и служебных событий адаптера)
  window.__CEF_ADAPTER__.hostSend = function (name, data) {
    var s = toArg(data);
    var hs = localHandlers[name] || [];
    for (var i = 0; i < hs.length; i++) hs[i](s);
    return hs.length;
  };
  // локальная доставка события подписчикам SPA (работает и с плагином): нужна для клавиш чата
  function dispatchLocal(name, data) {
    var s = toArg(data), n = 0;
    for (var i = 0; i < wrapped.length; i++) if (wrapped[i][0] === name) { try { wrapped[i][2](s); } catch (e) { } n++; }
    return n;
  }
  window.__CEF_ADAPTER__.dispatchLocal = dispatchLocal;

  // служебное: смена раскладки по событию с сервера
  api.on('cef_host_keyboard_layout', function (d) { window.__CEF_ADAPTER__.layout = (d && d.layout) || 'RU'; dispatchLayout(window.__CEF_ADAPTER__.layout); });

  window.cef = api;

  /* --- заглушки объектов хоста, которых у zottce нет (иначе ReferenceError в skin_selector/documents TECH/object_inspection) --- */
  function chromaKeyGreen(img, canvas) {
    var w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return;
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0);
    try {
      var d = ctx.getImageData(0, 0, w, h);
      var px = d.data;
      for (var i = 0; i < px.length; i += 4) {
        var r = px[i], g = px[i + 1], b = px[i + 2];
        if (g > 70 && g > r + 25 && g > b + 25) {
          var cut = Math.min(255, (g - Math.max(r, b)) * 4);
          px[i + 3] = Math.max(0, px[i + 3] - cut);
        }
      }
      ctx.putImageData(d, 0, 0);
    } catch (err) { }
  }
  function makeModel(kind) {
    function M(id, props) {
      this.kind = kind;
      this.id = id;
      this.props = props || {};
      this._el = null;
      this._cv = null;
      /* Фотку скина не рисуем: в дыре живой пед через камеру (MenuCam). */
    }
    M.prototype._mount = function () {
      try {
        var el = document.createElement('div');
        el.className = 'unm-cef-ped';
        el.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;z-index:3;pointer-events:none;display:flex;align-items:flex-end;justify-content:center;overflow:hidden;background:transparent;';
        var cv = document.createElement('canvas');
        cv.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;filter:drop-shadow(0 10px 18px rgba(0,0,0,.55));';
        el.appendChild(cv);
        this._el = el;
        this._cv = cv;
        this._host();
        this._skin(this.id);
      } catch (err) { }
    };
    M.prototype._host = function () {
      if (!this._el) return;
      var host = document.querySelector('app-ped-model-viewer');
      if (host) {
        this._el.style.position = 'absolute';
        this._el.style.left = '0';
        this._el.style.top = '0';
        this._el.style.width = '100%';
        this._el.style.height = '100%';
        if (this._el.parentNode !== host) host.appendChild(this._el);
        return;
      }
      this._el.style.position = 'fixed';
      this._el.style.zIndex = '80';
      (document.body || document.documentElement).appendChild(this._el);
      this._layout(this.props);
    };
    M.prototype._layout = function (p) {
      if (!this._el || !p) return;
      var x = +p.posX || 0, y = +p.posY || 0, w = +p.sizeX || 0, h = +p.sizeY || 0;
      // SPA передаёт getBoundingClientRect() в пикселях; shim ошибочно считал это 0..1
      if (w > 2 || h > 2 || x > 2 || y > 2) {
        this._el.style.left = x + 'px';
        this._el.style.top = y + 'px';
        this._el.style.width = (w || 220) + 'px';
        this._el.style.height = (h || 420) + 'px';
      } else {
        this._el.style.left = (x * 100) + '%';
        this._el.style.top = (y * 100) + '%';
        this._el.style.width = ((w || 0.22) * 100) + '%';
        this._el.style.height = ((h || 0.45) * 100) + '%';
      }
    };
    M.prototype._skin = function (id) {
      var self = this;
      var n = parseInt(id, 10);
      if (!n) n = parseInt(this.id, 10);
      if (!n || !this._cv) return;
      if (this._el) this._el.style.display = 'flex';
      var img = new Image();
      img.onload = function () { chromaKeyGreen(img, self._cv); };
      img.onerror = function () { if (self._el) self._el.style.display = 'none'; };
      img.src = 'assets/images/inventory/items/skins/' + n + '.png';
    };
    M.prototype._unmount = function () {
      if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
      this._el = null; this._cv = null;
    };
    ['set_position', 'set_rotation', 'set_color_rgb', 'set_rpm', 'set_remap', 'apply_animation', 'set_scale',
      'set_draw_always', 'set_draw_last', 'enable_lighting', 'set_lighting', 'play_anim', 'stop_anim', 'set_anim',
      'set_clothes', 'set_monochrome_factor', 'copy_localped_accessories', 'copy_localvehicle_tuning'].forEach(function (m) {
      M.prototype[m] = function () { return this; };
    });
    M.prototype.set_model_index = function (id) { this.id = id; this._skin(id); return this; };
    M.prototype.set_skin = function (id) { return this.set_model_index(id); };
    M.prototype.set_visible = function (v) {
      if (this._el) this._el.style.display = (v === false || v === 0) ? 'none' : 'flex';
      return this;
    };
    M.prototype.fit_to_bounds = function () { this._host(); this._layout(this.props); return this; };
    M.prototype.destroy = function () { this._unmount(); return this; };
    M.prototype.erase = function () { this._unmount(); return this; };
    return M;
  }
  function installHostModels() {
    window.cefModel = makeModel('model');
    window.cefModelPed = makeModel('ped');
    window.cefModelVehicle = makeModel('vehicle');
    if (typeof window.cefGpu === 'undefined') window.cefGpu = { isEnabled: false, setEnabled: function () { } };
  }
  installHostModels();
  setTimeout(installHostModels, 0);
  document.addEventListener('DOMContentLoaded', installHostModels);

  /* --- ЧАТ: в SPA Enter/Esc/T обрабатывает хост (клиент Amazing). У zottce такого нет — делаем здесь.
     Поле ввода чата существует в DOM только пока чат открыт (cef_chat_action {action:0}).
     Enter  -> cef_chat_action {action:1} (SEND: SPA шлёт cef_chat_response и закрывает поле)
     Escape -> cef_chat_action {action:0} (toggle -> закрыть)
     После закрытия: cef.set_focus(false) (вернуть управление игре) + cef_chat_state {open:0} на сервер.
     T НЕ перехватываем: T открывает штатный ввод SA-MP (OnPlayerText -> сервер -> сообщения в этот же чат). */
  function chatInputEl() {
    return document.querySelector('app-chat-new input, app-chat-new textarea, app-chat input, app-chat textarea, [class*="chat"] input, [class*="Chat"] input, [class*="chat"] textarea');
  }
  window.__CEF_ADAPTER__.chatOpen = false;
  function chatClosed() {
    setTimeout(function () {
      if (chatInputEl()) return; // не закрылся (например, SPA отменил)
      api.set_focus(false);
      api.trigger('cef_chat_state', { open: 0 });
    }, 30);
  }
  document.addEventListener('keydown', function (e) {
    var inp = chatInputEl();
    if (!inp) return;
    if (e.keyCode === 13) { // Enter
      if (e.__cefHandled) return; e.__cefHandled = true;
      setTimeout(function () { dispatchLocal('cef_chat_action', { action: 1 }); chatClosed(); }, 0);
    } else if (e.keyCode === 27) { // Escape
      if (e.__cefHandled) return; e.__cefHandled = true;
      setTimeout(function () { dispatchLocal('cef_chat_action', { action: 0 }); chatClosed(); }, 0);
    }
  }, true);
  api.on('cef_chat_action', function (d) {
    if (d && d.action === 0) {
      window.__CEF_ADAPTER__.chatOpen = !!(d.data === 1 || d.data === true || d.data === '1');
      setTimeout(function () {
        var open = window.__CEF_ADAPTER__.chatOpen || !!chatInputEl() || textFieldFocused();
        window.__CEF_ADAPTER__.chatOpen = open;
        api.trigger('cef_chat_state', { open: open ? 1 : 0 });
      }, 30);
    }
  });

  /* --- КЛАВИШИ ИГРЫ -> Pawn (как делала старая страница cef/amazing/index.html): game:KeyReleased <keyCode>
     ALT 18 (завод/развоз/метки), CTRL 17 (двигатель), B 66 (покупка дома), E 69, L 76, N 78, P 80, Y 89.
     Не шлём, пока открыт ввод SPA-чата или любое текстовое поле (диалог). */
  function unfreezeUi() {
    hideInvRmb();
    try {
      document.body.classList.remove('cdk-global-scrollblock');
      document.documentElement.classList.remove('cdk-global-scrollblock');
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
      document.body.style.pointerEvents = '';
      document.documentElement.style.pointerEvents = '';
    } catch (err) { }
  }
  function wipeStuckOverlays() {
    /* Только нативное Angular-ПКМ. Окно кейса не трогаем. */
    try {
      var list = document.querySelectorAll('.cdk-overlay-backdrop, .cdk-overlay-pane');
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (!el || el.id === 'unm-inv-rmb') continue;
        var tx = (el.textContent || '').replace(/\s+/g, ' ');
        if (tx.indexOf('Открыть') !== -1 && tx.indexOf('Выбросить') !== -1) {
          if (el.parentNode) el.parentNode.removeChild(el);
        }
      }
    } catch (err) { }
  }
  function hideInvRmb() {
    var m = document.getElementById('unm-inv-rmb');
    if (m && m.parentNode) m.parentNode.removeChild(m);
  }
  function forceCloseMenu() {
    unfreezeUi();
    window.__CEF_ADAPTER__.caseOpen = false;
    try { dispatchLocal('cef_cases_close', {}); } catch (err) { }
    try { dispatchLocal('menu_close', {}); } catch (err) { }
    try { api.trigger('cef_rpc_cases', { key: 1 }); } catch (err) { }
    emitGameKey(27);
  }
  function showInvRmb(x, y, slot, type) {
    hideInvRmb();
    wipeStuckOverlays();
    var m = document.createElement('div');
    m.id = 'unm-inv-rmb';
    m.style.cssText = 'position:fixed;left:' + x + 'px;top:' + y + 'px;z-index:2147483647;background:#16161c;border:1px solid #3d3d48;border-radius:10px;min-width:180px;padding:4px 0;font:14px/1.35 sans-serif;color:#f3f3f3;box-shadow:0 12px 32px rgba(0,0,0,.55);pointer-events:auto;';
    function row(label, action) {
      var b = document.createElement('div');
      b.textContent = label;
      b.style.cssText = 'padding:9px 18px;cursor:pointer;';
      b.onmouseenter = function () { b.style.background = '#2a2a33'; };
      b.onmouseleave = function () { b.style.background = 'transparent'; };
      b.onmousedown = function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
        unfreezeUi();
        try { api.trigger('cef_inventory_ui_response', { action: action, slotId: slot, type: type, itemType: type }); } catch (err) { }
      };
      m.appendChild(b);
    }
    row('Открыть', 1);
    row('Выбросить', 6);
    row('Переместить', 8);
    document.body.appendChild(m);
    if (m.getBoundingClientRect().right > window.innerWidth) m.style.left = Math.max(8, window.innerWidth - 200) + 'px';
    if (m.getBoundingClientRect().bottom > window.innerHeight) m.style.top = Math.max(8, window.innerHeight - 140) + 'px';
  }
  function invQtyCards() {
    var raw = [], nodes = document.querySelectorAll('app-menu .wrapper');
    for (var i = 0; i < nodes.length; i++) {
      var tx = (nodes[i].textContent || '').replace(/\s+/g, ' ');
      if (tx.indexOf('ID') !== -1) continue;
      if (!/\d+\s*\u0448\u0442/.test(tx)) continue;
      raw.push(nodes[i]);
    }
    var list = [];
    for (var a = 0; a < raw.length; a++) {
      var nested = false;
      for (var b = 0; b < raw.length; b++) {
        if (a !== b && raw[b].contains(raw[a])) { nested = true; break; }
      }
      if (!nested) list.push(raw[a]);
    }
    return list;
  }
  document.addEventListener('contextmenu', function (e) {
    var inMenu = false;
    try { inMenu = !!(e.target && e.target.closest && e.target.closest('app-menu, app-inventory, [class*="inventory"]')); } catch (err) { }
    if (!inMenu) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    var slot = -1, list = [];
    try { list = invQtyCards(); } catch (err) { }
    try {
      for (var j = 0; j < list.length; j++) {
        if (list[j] === e.target || (list[j].contains && list[j].contains(e.target))) { slot = 6 + j; break; }
      }
    } catch (err) { }
    if (slot < 6) return;
    showInvRmb(e.clientX, e.clientY, slot, 0);
  }, true);
  document.addEventListener('mousedown', function (e) {
    if (e.button === 0) {
      var m = document.getElementById('unm-inv-rmb');
      if (m && !m.contains(e.target)) hideInvRmb();
    }
  }, true);
  (function injectInvCss() {
    var s = document.createElement('style');
    s.textContent = 'app-ped-model-viewer{background:transparent !important;}'
      + '.unm-cef-ped{display:none !important;}'
      + '#unm-inv-rmb{pointer-events:auto !important;z-index:2147483647 !important;}';
    (document.head || document.documentElement).appendChild(s);
  })();
  try {
    api.on('cef_cases_open', function () { window.__CEF_ADAPTER__.caseOpen = true; });
    api.on('cef_cases_close', function () { window.__CEF_ADAPTER__.caseOpen = false; });
  } catch (err) { }
  var GAME_KEYS = { 17: 1, 18: 1, 27: 1, 66: 1, 69: 1, 76: 1, 78: 1, 80: 1, 89: 1 };
  function textFieldFocused() {
    var a = document.activeElement;
    return !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable));
  }
  function chatIsOpen() {
    /* Только реальное поле ввода: залипший chatOpen блокировал T и чат не открывался. */
    return !!(chatInputEl() || textFieldFocused());
  }
  function spaMenuOpen() {
    try {
      if (window.__CEF_ADAPTER__.caseOpen) return true;
      var m = document.querySelector('app-menu');
      if (m) {
        var r = m.getBoundingClientRect();
        if (r.width > 80 && r.height > 80) return true;
      }
      var c = document.querySelector('app-cases, app-case, app-case-opening, [class*="cases"]');
      if (c) {
        var r2 = c.getBoundingClientRect();
        if (r2.width > 80 && r2.height > 80) return true;
      }
    } catch (err) { }
    return false;
  }
  function emitGameKey(code) {
    if (plugin) { try { plugin.emit('game:KeyReleased', String(code)); } catch (err) { } }
    else window.__CEF_ADAPTER__.log.push(['send', 'game:KeyReleased', String(code)]);
  }
  document.addEventListener('keydown', function (e) {
    if (e.keyCode === 84 || e.keyCode === 117) { // T / F6 — в чат букву, в игру НЕ слать
      if (chatIsOpen()) return;
      emitGameKey(e.keyCode);
      return;
    }
    if (e.keyCode === 9) {
      if (chatInputEl()) return;
      if (spaMenuOpen()) {
        // SPA после ПКМ часто ставит modality — сама Tab не закрывает.
        // Шлём ESC в pawn (только close), не Toggle.
        forceCloseMenu();
        e.preventDefault();
        return;
      }
      emitGameKey(9);
      return;
    }
    if (e.keyCode === 73) { // I — инвентарь
      if (chatIsOpen()) return;
      emitGameKey(73);
    }
  }, true);
  document.addEventListener('keyup', function (e) {
    if (e.keyCode === 84 || e.keyCode === 117) return; // T уже на keydown, повторно не закрывать
    if (!GAME_KEYS[e.keyCode]) return;
    if (e.keyCode === 27) {
      if (chatInputEl()) return;
      forceCloseMenu();
      return;
    }
    if (chatIsOpen()) return;
    emitGameKey(e.keyCode);
  }, true);

  /* --- LEGACY-события старой главной страницы cef/amazing/index.html, которые мод шлёт в MAIN-браузер.
     game:fadeScreen 1/0 — затемнение экрана; после затемнения страница ОБЯЗАНА ответить game:requestTeleport,
     иначе мод не выполнит телепорт (дома/интерьеры/парковки: OnPlayerRequestTeleport). */
  function truthy(v) { return v === true || v === 1 || v === '1' || v === 'true'; }
  function hostEmit(name, str) {
    if (plugin) { try { plugin.emit(name, str); } catch (err) { } }
    else window.__CEF_ADAPTER__.log.push(['send', name, str]);
  }
  var fadeEl = null, fadeTimer = 0;
  function fadeScreen(on) {
    if (!fadeEl) {
      fadeEl = document.createElement('div');
      fadeEl.id = 'cef-legacy-fade';
      fadeEl.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;background:#000;opacity:0;pointer-events:none;z-index:2147483647;transition:opacity .35s ease';
      (document.body || document.documentElement).appendChild(fadeEl);
    }
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = 0; }
    if (on) {
      fadeEl.style.opacity = '1';
      fadeTimer = setTimeout(function () { fadeTimer = 0; hostEmit('game:requestTeleport', '1'); }, 400);
    } else {
      fadeEl.style.opacity = '0';
    }
  }
  api.on('game:fadeScreen', function (v) { fadeScreen(truthy(Array.isArray(v) ? v[0] : v)); });
  window.__CEF_ADAPTER__.fadeScreen = fadeScreen;

  /* playSound/stopSound/stopAllSounds: файлы лежат в сборке в cef/amazing/sfx/ (rain.mp3, reg.mp3) */
  var sounds = {};
  api.on('playSound', function (a) {
    var args = Array.isArray(a) ? a : [a];
    var file = String(args[0] || ''), vol = +args[1], loop = truthy(args[2]);
    if (!file) return;
    if (!(vol >= 0)) vol = 100;
    try {
      var snd = sounds[file] || (sounds[file] = new Audio('../amazing/sfx/' + file));
      snd.volume = Math.max(0, Math.min(1, vol / 100)); snd.loop = loop; snd.currentTime = 0;
      var pr = snd.play(); if (pr && pr.catch) pr.catch(function () { });
    } catch (e) { }
  });
  api.on('stopSound', function (a) {
    var file = String(Array.isArray(a) ? a[0] : a), snd = sounds[file];
    if (snd) { try { snd.pause(); snd.currentTime = 0; } catch (e) { } }
  });
  api.on('stopAllSounds', function () { for (var k in sounds) { try { sounds[k].pause(); } catch (e) { } } });
  /* прочие legacy-события старой страницы: в SPA аналогов нет — глушим без ошибок */
  function notifFromLegacy(d, view, type) {
    var a = Array.isArray(d) ? d : (d == null ? [] : [d]);
    var title = '', text = '', time = 6000;
    if (a.length >= 3) { title = String(a[1] || ''); text = String(a[2] || ''); time = +a[3] || 6000; }
    else if (d && typeof d === 'object' && !Array.isArray(d)) { title = d.title || ''; text = d.text || d.message || ''; time = +d.time || 6000; }
    else if (typeof d === 'string') text = d;
    dispatchLocal('cef_notifications_show', { viewType: view || 'centered', messageType: type || 'error', title: title, text: text, time: time, label: '' });
  }
  api.on('notify:full', function (d) { notifFromLegacy(d, 'centered', 'error'); });
  api.on('game:ShowNotification', function (d) { notifFromLegacy(d, 'push', 'info'); });

  ['game:quit', 'system:hide', 'classic:hud:authMode', 'classic:hud:update', 'game:showCursor', 'game:setCategories',
    'game:ShowKeyHold', 'game:openSkinSelector', 'game:SetSpeedEngine', 'game:SetSpeedLights',
    'game:updateCI', 'passport:show', 'license:show', 'carpass:show', 'udo:show', 'tab:stats', 'radmenu:open', 'time:update'].forEach(function (n) { api.on(n, function () { }); });

  /* --- SKIN SELECTOR: картинка скина в дыре CEF + apply_animation -> cef_skin_preview на сервер. */
  (function hookPedPreview() {
    var last = -1;
    function hook() {
      var P = window.cefModelPed && window.cefModelPed.prototype;
      if (!P) return;
      P.apply_animation = function (lib, anim) {
        if (this.kind === 'ped' && lib === 'PED' && anim === 'inventory_idle' && typeof this.id === 'number' && this.id !== last) {
          last = this.id;
          api.trigger('cef_skin_preview', { skinId: this.id });
        }
        return this;
      };
    }
    hook();
    setTimeout(function () { installHostModels(); hook(); }, 50);
    setTimeout(function () { installHostModels(); hook(); }, 400);
    api.on('cef_skin_selector_hide', function () { last = -1; });
    api.on('cef_skin_selector_show', function () { last = -1; });
  })();

  /* --- Ошибки JS -> сервер (printf в консоль сервера), не больше 20 за сессию --- */
  (function reportErrors() {
    var n = 0;
    function send(msg) { if (n++ >= 20) return; try { api.trigger('cef_js_error', { msg: String(msg).slice(0, 300) }); } catch (e) { } }
    window.addEventListener('error', function (e) { send((e && e.message) || 'error'); });
    window.addEventListener('unhandledrejection', function (e) { var r = e && e.reason; send('unhandledrejection: ' + ((r && (r.message || r)) || '')); });
  })();

  /* Клик/ПКМ инвентаря не перехватываем: SPA само рисует меню (Открыть/Выбросить) и drag. */

  /* Чёрные квадраты на радар/деньги — НЕ рисуем. Старые ноды с прошлого адаптера снимаем. */
  (function removeHudCovers() {
    function wipe() {
      ['cef-hide-samp-radar', 'cef-hide-samp-money'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el && el.parentNode) el.parentNode.removeChild(el);
      });
    }
    wipe();
    if (document.body) wipe();
    else document.addEventListener('DOMContentLoaded', wipe);
  })();

  /* --- Магазин: спрятать золотую «C» (кредиты) рядом с «Амазингов» --- */
  (function hideShopCreditsC() {
    function hide() {
      try {
        if (!document.body) return;
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        var node;
        while ((node = walker.nextNode())) {
          var tv = node.nodeValue;
          if (!tv) continue;
          if (tv.indexOf('[object Object]') !== -1) node.nodeValue = tv.replace(/\[object Object\]/g, '0');
          if (/Амазинг/.test(tv)) {
            node.nodeValue = node.nodeValue.replace(/\s[CСEe]\s*$/, '');
            var wrap = node.parentElement;
            if (wrap && wrap.parentElement) {
              var kids = wrap.parentElement.children;
              var seenAmz = false;
              for (var k = 0; k < kids.length; k++) {
                var kt = (kids[k].textContent || '').trim();
                if (/Амазинг/.test(kt)) { seenAmz = true; continue; }
                if (!seenAmz) continue;
                if (/ПОПОЛНИТЬ|пополнить/i.test(kt)) break;
                if (kt === 'C' || kt === 'С' || kt === 'e' || kt === 'E' || kt.length <= 1) {
                  kids[k].style.display = 'none';
                  kids[k].style.visibility = 'hidden';
                }
              }
            }
          }
        }
        var els = document.body.getElementsByTagName('*');
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          var cls = (el.className && String(el.className)) || '';
          if (/credit/i.test(cls) && /shop|donate|header|balance|currency/i.test(cls + (el.parentElement && el.parentElement.className || ''))) {
            el.style.display = 'none';
          }
          var tx = (el.textContent || '').trim();
          if (tx === 'C' || tx === 'С') {
            var ctx = '';
            var pEl = el.parentElement;
            var prev = el.previousElementSibling;
            if (pEl) ctx += pEl.textContent || '';
            if (prev) ctx += prev.textContent || '';
            if (/Амазинг|Рубл|У Вас/i.test(ctx)) {
              el.style.display = 'none';
              el.style.visibility = 'hidden';
              el.style.width = '0';
              el.style.height = '0';
              el.style.overflow = 'hidden';
            }
          }
        }
      } catch (e) { }
    }
    var t = 0;
    function tick() { hide(); if (++t < 80) setTimeout(tick, 400); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
    else tick();
    if (typeof MutationObserver === 'function') {
      var obs = new MutationObserver(function () { hide(); });
      function arm() { if (document.body) obs.observe(document.body, { childList: true, subtree: true, characterData: true }); }
      if (document.body) arm(); else document.addEventListener('DOMContentLoaded', arm);
    }
  })();

  /* Чат не должен висеть поверх TAB/магазина */
  api.on('menu_open', function () {
    try {
      var nodes = document.querySelectorAll('app-chat-new, app-chat, [class*="chat-new"]');
      for (var i = 0; i < nodes.length; i++) { nodes[i].style.zIndex = '1'; nodes[i].style.pointerEvents = 'none'; }
    } catch (e) { }
    setTimeout(function () {
      var peds = document.querySelectorAll('.unm-cef-ped');
      var host = document.querySelector('app-ped-model-viewer');
      if (!host) return;
      for (var i = 0; i < peds.length; i++) {
        peds[i].style.position = 'absolute';
        peds[i].style.left = '0';
        peds[i].style.top = '0';
        peds[i].style.width = '100%';
        peds[i].style.height = '100%';
        if (peds[i].parentNode !== host) host.appendChild(peds[i]);
      }
    }, 80);
  });
  api.on('menu_close', function () {
    wipeStuckOverlays();
    try {
      var nodes = document.querySelectorAll('app-chat-new, app-chat, [class*="chat-new"]');
      for (var i = 0; i < nodes.length; i++) { nodes[i].style.zIndex = ''; nodes[i].style.pointerEvents = ''; }
    } catch (e) { }
  });

  /* --- standalone (обычный браузер без плагина): авто-handshake, чтобы страница вообще стартовала --- */
  if (!plugin) {
    var q = {};
    try { q = Object.fromEntries(new URLSearchParams(location.search).entries()); } catch (e) { }
    var mode = q.mode !== undefined ? +q.mode : 1;
    window.__CEF_STANDALONE_ON_TRIGGER = function (name) {
      if (name === 'cef_app_started') setTimeout(function () {
        window.__CEF_ADAPTER__.hostSend('cef_app_set_config', { mode: mode, theme: q.theme || 'dark' });
        window.__CEF_ADAPTER__.hostSend('cef_app_state_init', { serverId: 1, time: new Date().toISOString(), donateMultiplier: 1 });
      }, 50);
    };
  }
})();
