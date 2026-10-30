/* common.js - helpers shared by index.html (practice) and author.html.
 * Plain script, no modules, no fetch(): everything works when opened from file://.
 * Piece data is loaded by injecting <script src="pieces/<id>/piece.js">.
 */
(function (root) {
  'use strict';
  var PP = {};

  PP.fmt = function (t) {
    if (!isFinite(t)) t = 0;
    var m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  };

  PP.r5 = function (v) { return Math.round(v * 100000) / 100000; };

  PP.isTyping = function (el) {
    var tag = (el && el.tagName || '').toLowerCase();
    if (tag === 'select' || tag === 'textarea') return true;
    return tag === 'input' && el.type !== 'range' && el.type !== 'checkbox';
  };

  /* ---------- loading ---------- */

  PP.loadScript = function (src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { s.remove(); resolve(); };
      s.onerror = function () { s.remove(); reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  };

  PP.loadPiece = function (id) {
    var base = 'pieces/' + encodeURIComponent(id) + '/';
    return PP.loadScript(base + 'piece.js?v=' + Date.now()).then(function () {
      var p = root.PIECES && root.PIECES[id];
      if (!p) throw new Error('pieces/' + id + '/piece.js did not define piece "' + id + '"');
      p.base = base;
      p.timeline = (p.timeline && p.timeline.length) ? p.timeline : [];
      return p;
    });
  };

  /* ---------- timeline logic (pure, unit-testable) ---------- */

  /* index of the last event whose time <= t, or -1 */
  PP.eventIndexAt = function (tl, t) {
    var lo = 0, hi = tl.length - 1, r = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (tl[mid].t <= t) { r = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return r;
  };

  /* indices of all events that point to measure number m (1-based) */
  PP.occurrences = function (tl, m) {
    var out = [];
    for (var i = 0; i < tl.length; i++) if (tl[i].m === m) out.push(i);
    return out;
  };

  /* Loop from measure a to measure b (1-based, a <= b).
   * Start = the occ-th occurrence of a. End = end of the first occurrence of b
   * at or after that start. An event ends where the next one begins. */
  PP.resolveLoop = function (tl, endTime, a, b, occ) {
    var occs = PP.occurrences(tl, a);
    if (!occs.length) return null;
    var i = occs[Math.min(occ || 0, occs.length - 1)], j = -1;
    for (var k = i; k < tl.length; k++) if (tl[k].m === b) { j = k; break; }
    if (j < 0) return null;
    var start = tl[i].t;
    var end = (j + 1 < tl.length) ? tl[j + 1].t : endTime;
    if (!(end > start)) return null;
    return { i: i, j: j, start: start, end: end };
  };

  /* ---------- sheet (page images + clickable measure boxes) ---------- */

  PP.buildSheet = function (container, piece) {
    container.innerHTML = '';
    var layers = [];
    piece.pages.forEach(function (pg, pi) {
      var page = document.createElement('div');
      page.className = 'page';
      page.style.aspectRatio = pg.width + ' / ' + pg.height;
      var img = document.createElement('img');
      img.src = piece.base + pg.src;
      img.alt = 'Page ' + (pi + 1);
      img.draggable = false;
      var layer = document.createElement('div');
      layer.className = 'layer';
      page.appendChild(img);
      page.appendChild(layer);
      container.appendChild(page);
      layers.push(layer);
    });
    var sheet = { els: [] };
    sheet.render = function (measures, onClick) {
      layers.forEach(function (l) { l.innerHTML = ''; });
      sheet.els.length = 0;
      measures.forEach(function (m, i) {
        var d = document.createElement('div');
        d.className = 'm';
        d.style.left = (m.x * 100) + '%';
        d.style.top = (m.y * 100) + '%';
        d.style.width = (m.w * 100) + '%';
        d.style.height = (m.h * 100) + '%';
        var n = document.createElement('span');
        n.className = 'num';
        n.textContent = i + 1;
        d.appendChild(n);
        d.addEventListener('click', function (e) { onClick(i, e, d); });
        layers[m.page].appendChild(d);
        sheet.els.push(d);
      });
    };
    return sheet;
  };

  /* scroll only when el is outside the comfortable area (keeps motion calm) */
  PP.keepVisible = function (el, topInset) {
    var r = el.getBoundingClientRect(), vh = window.innerHeight;
    if (r.top < topInset + 10 || r.bottom > vh - 20) {
      window.scrollTo({
        top: window.scrollY + r.top - (topInset + (vh - topInset) / 3),
        behavior: 'smooth'
      });
    }
  };

  /* ---------- audio transport (slider, jumps, speed) ---------- */

  PP.setRate = function (audio, r) {
    audio.playbackRate = r;
    ['preservesPitch', 'mozPreservesPitch', 'webkitPreservesPitch'].forEach(function (k) {
      if (k in audio) audio[k] = true;
    });
  };

  PP.safe = {
    get: function (k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { root.localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del: function (k) { try { root.localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  /* Expects elements #play #slider #time, buttons [data-jump] and [data-rate].
   * opts.toggle: custom play/pause handler; opts.onFrame(t, playing): every animation frame. */
  PP.bindTransport = function (audio, opts) {
    var play = document.getElementById('play');
    var slider = document.getElementById('slider');
    var time = document.getElementById('time');
    var dragging = false;
    var toggle = opts.toggle || function () {
      if (audio.paused) audio.play().catch(function () {}); else audio.pause();
    };
    function dur() { return isFinite(audio.duration) ? audio.duration : 0; }
    function paint() {
      var t = audio.currentTime;
      if (!dragging) slider.value = t;
      time.textContent = PP.fmt(t) + ' / ' + PP.fmt(dur());
      play.textContent = audio.paused ? '▶' : '⏸';
    }
    audio.addEventListener('loadedmetadata', function () { slider.max = dur(); paint(); });
    slider.addEventListener('pointerdown', function () { dragging = true; });
    window.addEventListener('pointerup', function () { dragging = false; });
    slider.addEventListener('input', function () { audio.currentTime = parseFloat(slider.value); });
    play.addEventListener('click', toggle);

    Array.prototype.forEach.call(document.querySelectorAll('[data-jump]'), function (b) {
      b.addEventListener('click', function () {
        var t = audio.currentTime + parseFloat(b.dataset.jump);
        audio.currentTime = Math.min(Math.max(0, t), dur() || 1e9);
      });
    });

    var rateBtns = Array.prototype.slice.call(document.querySelectorAll('[data-rate]'));
    function applyRate(r) {
      PP.setRate(audio, r);
      rateBtns.forEach(function (b) { b.classList.toggle('on', parseFloat(b.dataset.rate) === r); });
      PP.safe.set('pp-rate', String(r));
    }
    rateBtns.forEach(function (b) {
      b.addEventListener('click', function () { applyRate(parseFloat(b.dataset.rate)); });
    });
    var saved = parseFloat(PP.safe.get('pp-rate'));
    var initial = rateBtns.some(function (b) { return parseFloat(b.dataset.rate) === saved; }) ? saved : 1;
    applyRate(initial);
    audio.addEventListener('loadstart', function () { applyRate(parseFloat(PP.safe.get('pp-rate')) || 1); });

    document.addEventListener('keydown', function (e) {
      if (e.code !== 'Space' || PP.isTyping(e.target)) return;
      e.preventDefault();
      toggle();
    });
    document.addEventListener('keyup', function (e) {
      if (e.code === 'Space' && !PP.isTyping(e.target)) e.preventDefault();
    });

    (function tick() {
      paint();
      if (opts.onFrame) opts.onFrame(audio.currentTime, !audio.paused);
      requestAnimationFrame(tick);
    })();
    return { paint: paint, toggle: toggle };
  };

  /* ---------- writing piece.js ---------- */

  PP.serialize = function (p) {
    var L = JSON.stringify;
    function lines(arr) { return arr.map(function (x) { return '  ' + L(x); }).join(',\n'); }
    var hasTl = p.timeline && p.timeline.length;
    var s = 'window.PIECES = window.PIECES || {};\n';
    s += 'window.PIECES[' + L(p.id) + '] = {\n';
    s += ' "id": ' + L(p.id) + ',\n';
    s += ' "title": ' + L(p.title) + ',\n';
    s += ' "audio": ' + L(p.audio) + ',\n';
    s += ' "pages": [\n' + lines(p.pages) + '\n ],\n';
    s += ' "measures": [\n' + lines(p.measures) + '\n ],\n';
    if (hasTl) {
      s += ' "timeline": [\n' + lines(p.timeline) + '\n ],\n';
      s += ' "endTime": ' + L(p.endTime) + '\n';
    } else {
      s += ' "timeline": null,\n "endTime": null\n';
    }
    return s + '};\n';
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PP;
  else root.PP = PP;
})(typeof window !== 'undefined' ? window : globalThis);
