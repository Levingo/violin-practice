/* author.js - add the timing table to a piece (only pieces without timing are offered) */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var audio = $('audio'), bar = $('bar'), statusEl = $('status'), notice = $('notice');
  var pieceSel = $('pieceSel'), followCb = $('follow');
  var side = $('side'), evBody = $('events');

  var piece = null, sheet = null;
  var measures = [], events = [], endTime = null;
  var mode = 'measures', tool = null, selM = -1, armed = null, lastNow = -2;
  var sheetEl = $('sheet');
  var extendFrom = -1;     // measure being extended (tool "extend")
  var drag = null;         // rubber band while drawing a staff (tool "addstaff")
  var guideEl = null;      // vertical guide line while choosing the new end
  var history = [];
  var pieceSig = '';   // fingerprint of the measures in piece.js (a draft only applies to those)

  function sigOf(list) {
    var str = JSON.stringify(list), h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return String(h);
  }

  function say(msg, bad) { statusEl.textContent = msg || ''; statusEl.style.color = bad ? '#ff9a9a' : ''; }

  /* ---------- history / draft ---------- */

  function snap() {
    history.push(JSON.stringify({ m: measures, e: events, end: endTime }));
    if (history.length > 150) history.shift();
  }
  function undo() {
    if (!history.length) return;
    var s = JSON.parse(history.pop());
    measures = s.m; events = s.e; endTime = s.end; armed = null; selM = -1;
    rerender(); persist();
  }
  function draftKey() { return 'pp-draft-' + piece.id; }
  function persist() {
    if (!piece) return;
    PP.safe.set(draftKey(), JSON.stringify({ m: measures, e: events, end: endTime, sig: pieceSig }));
  }

  /* ---------- rendering ---------- */

  function nextIdx() {
    if (mode !== 'tap' || !events.length) return mode === 'tap' ? 0 : -1;
    var m = events[events.length - 1].m;      // measure number m -> index m is the one after it
    return m < measures.length ? m : -1;
  }

  function decorate() {
    var nx = nextIdx();
    sheet.els.forEach(function (el, i) {
      el.classList.toggle('sel', mode === 'measures' && i === selM);
      el.classList.toggle('next', i === nx);
    });
  }

  function rerender() {
    sheet.render(measures, onMeasure);
    lastNow = -2;
    $('mCount').textContent = measures.length;
    $('endT').value = endTime == null ? '' : endTime;
    renderList();
    decorate();
    updateButtons();
  }

  function updateButtons() {
    var locked = events.length > 0;
    $('delM').disabled = locked || selM < 0;
    $('mergeM').disabled = locked || selM < 0 || selM >= measures.length - 1;
    $('splitM').disabled = $('addS').disabled = locked;
    $('extM').disabled = locked || !measures.length;
    $('splitM').classList.toggle('on', tool === 'split');
    $('addS').classList.toggle('on', tool === 'addstaff');
    $('extM').classList.toggle('on', tool === 'extend');
    $('splitM').textContent = tool === 'split' ? 'Splitting… (click to stop)' : 'Split…';
    $('addS').textContent = tool === 'addstaff' ? 'Adding… (click to stop)' : 'Add staff…';
    $('extM').textContent = tool === 'extend' ? 'Extending… (click to stop)' : 'Extend end…';
    var hint = 'Click a measure to select it. Merge, delete, split, add a missing staff or extend a measure with the buttons above.';
    if (locked) hint = 'Measure editing is locked while taps exist. Clear all taps to edit measures again.';
    else if (tool === 'split') hint = 'Click inside a measure where the missing barline is. Click again for more barlines; press Split (or Esc) to stop.';
    else if (tool === 'addstaff') hint = 'Drag a rectangle over the missing staff: from its left end to its right end, a little above and below the lines. It is added as one measure; then split it at the barlines.';
    else if (tool === 'extend') hint = extendFrom < 0
      ? 'Click the measure you want to extend.'
      : 'Now click the new end position (a vertical line shows where). Following measures on the same line that start before it are removed.';
    $('mHint').textContent = hint;
    if (!(tool === 'extend' && extendFrom >= 0)) hideGuide();
    document.body.classList.toggle('tool-addstaff', tool === 'addstaff');
    document.body.classList.toggle('tool-extend', tool === 'extend');
    $('download').disabled = !events.length;
    $('saveHint').textContent = events.length
      ? events.length + ' taps. Download, replace pieces/' + piece.id + '/piece.js with the file, then commit.'
      : 'Tap at least one measure first.';
    $('undo').disabled = !history.length;
    document.body.classList.toggle('splitting', tool === 'split');
  }

  function renderList() {
    var cur = PP.eventIndexAt(events, audio.currentTime || 0);
    evBody.innerHTML = '';
    events.forEach(function (e, k) {
      var tr = document.createElement('tr');
      tr.dataset.k = k;
      if (k === armed) tr.className = 'armed';
      tr.innerHTML = '<td>' + (k + 1) + '</td><td>' + e.m + '</td><td>' + e.t.toFixed(3) + '</td>' +
        '<td class="acts">' +
        '<button data-act="play" title="Play from just before">▶</button>' +
        '<button data-act="dn" title="Earlier by 50 ms">−</button>' +
        '<button data-act="up" title="Later by 50 ms">+</button>' +
        '<button data-act="retap" title="Re-tap: next measure click replaces this row">↻</button>' +
        '<button data-act="del" title="Delete">✕</button></td>';
      evBody.appendChild(tr);
    });
    markCurrentRow(cur, true);
  }

  var lastRow = -2;
  function markCurrentRow(cur, force) {
    if (cur === lastRow && !force) return;
    lastRow = cur;
    Array.prototype.forEach.call(evBody.children, function (tr, k) { tr.classList.toggle('cur', k === cur); });
  }

  /* ---------- measure editing ---------- */

  function sameRow(a, b) { return a.page === b.page && Math.abs(a.y - b.y) < a.h * 0.5; }

  function splitAt(i, e, el) {
    var r = el.getBoundingClientRect(), f = (e.clientX - r.left) / r.width, m = measures[i];
    if (f < 0.08 || f > 0.92) { say('Click nearer the middle of the measure.', true); return; }
    var cut = m.x + f * m.w;
    snap();
    measures.splice(i, 1,
      { page: m.page, x: PP.r5(m.x), y: m.y, w: PP.r5(cut - m.x), h: m.h },
      { page: m.page, x: PP.r5(cut), y: m.y, w: PP.r5(m.x + m.w - cut), h: m.h });
    selM = -1; rerender(); persist();
    say('Measure split. Click again to add more barlines, or press Split to stop.');
  }

  function setTool(name) {
    tool = (tool === name) ? null : name;
    extendFrom = (tool === 'extend' && selM >= 0) ? selM : -1;
    drag = null;
    updateButtons();
  }

  /* ----- add a missing staff: drag a rectangle ----- */

  function pageIndex(pageEl) { return Array.prototype.indexOf.call(sheetEl.children, pageEl); }
  function clamp01(v) { return Math.min(1, Math.max(0, v)); }

  sheetEl.addEventListener('pointerdown', function (e) {
    if (tool !== 'addstaff' || events.length || mode !== 'measures' || e.button) return;
    var pageEl = e.target.closest('.page');
    if (!pageEl) return;
    e.preventDefault();
    var r = pageEl.getBoundingClientRect();
    var band = document.createElement('div');
    band.className = 'rubber';
    pageEl.appendChild(band);
    drag = { pageEl: pageEl, band: band, x0: clamp01((e.clientX - r.left) / r.width), y0: clamp01((e.clientY - r.top) / r.height), x1: 0, y1: 0 };
    drag.x1 = drag.x0; drag.y1 = drag.y0;
    sheetEl.setPointerCapture(e.pointerId);
  });

  sheetEl.addEventListener('pointermove', function (e) {
    if (drag) {
      var r = drag.pageEl.getBoundingClientRect();
      drag.x1 = clamp01((e.clientX - r.left) / r.width);
      drag.y1 = clamp01((e.clientY - r.top) / r.height);
      var s = drag.band.style;
      s.left = Math.min(drag.x0, drag.x1) * 100 + '%';
      s.top = Math.min(drag.y0, drag.y1) * 100 + '%';
      s.width = Math.abs(drag.x1 - drag.x0) * 100 + '%';
      s.height = Math.abs(drag.y1 - drag.y0) * 100 + '%';
    } else if (tool === 'extend' && extendFrom >= 0 && measures[extendFrom]) {
      showGuide(e);
    }
  });

  function endDrag() {
    if (!drag) return;
    var d = drag; drag = null;
    d.band.remove();
    var x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    var w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    if (w < 0.03 || h < 0.012) { say('That rectangle is too small. Drag over the whole staff.', true); return; }
    addStaff(pageIndex(d.pageEl), x, y, w, h);
  }
  sheetEl.addEventListener('pointerup', endDrag);
  sheetEl.addEventListener('pointercancel', function () { if (drag) { drag.band.remove(); drag = null; } });

  function addStaff(pi, x, y, w, h) {
    // reading order: after every measure that lies above it, before the next one
    var yc = y + h / 2, at = measures.length;
    for (var k = 0; k < measures.length; k++) {
      var m = measures[k];
      if (m.page > pi || (m.page === pi && m.y + m.h / 2 > yc)) { at = k; break; }
    }
    snap();
    measures.splice(at, 0, { page: pi, x: PP.r5(x), y: PP.r5(y), w: PP.r5(w), h: PP.r5(h) });
    selM = at; tool = 'split'; extendFrom = -1;
    rerender(); persist();
    say('Staff added as measure ' + (at + 1) + '. Click inside it at each barline to split it.');
  }

  /* ----- extend a measure to a new end x ----- */

  function showGuide(e) {
    var m = measures[extendFrom], pageEl = sheetEl.children[m.page];
    if (!pageEl) return;
    if (!guideEl || guideEl.parentNode !== pageEl) {
      hideGuide();
      guideEl = document.createElement('div');
      guideEl.className = 'guide';
      pageEl.appendChild(guideEl);
    }
    var r = pageEl.getBoundingClientRect();
    guideEl.style.left = clamp01((e.clientX - r.left) / r.width) * 100 + '%';
    guideEl.style.top = m.y * 100 + '%';
    guideEl.style.height = m.h * 100 + '%';
  }
  function hideGuide() { if (guideEl) { guideEl.remove(); guideEl = null; } }

  sheetEl.addEventListener('click', function (e) {
    if (tool !== 'extend' || events.length || mode !== 'measures') return;
    var pageEl = e.target.closest('.page');
    if (!pageEl) return;
    if (extendFrom < 0) {
      var mEl = e.target.closest('.m'), i = mEl ? sheet.els.indexOf(mEl) : -1;
      if (i < 0) { say('Click on the measure you want to extend.', true); return; }
      extendFrom = i; selM = i;
      decorate(); updateButtons(); showGuide(e);
      say('Measure ' + (i + 1) + ': now click the new end position.');
      return;
    }
    var r = pageEl.getBoundingClientRect();
    extendTo(extendFrom, pageIndex(pageEl), clamp01((e.clientX - r.left) / r.width));
  });

  function extendTo(i, pi, fx) {
    var a = measures[i];
    if (!a) return;
    if (pi !== a.page) { say('Click on the same page as the measure.', true); return; }
    if (fx <= a.x + 0.02) { say('The new end must be to the right of the measure start.', true); return; }
    snap();
    var removed = 0;
    while (i + 1 < measures.length && sameRow(a, measures[i + 1]) && measures[i + 1].x < fx) {
      measures.splice(i + 1, 1);
      removed++;
    }
    a.w = PP.r5(fx - a.x);
    tool = null; extendFrom = -1; selM = i;
    rerender(); persist();
    say('Measure ' + (i + 1) + ' extended.' + (removed ? ' ' + removed + ' following measure' + (removed > 1 ? 's' : '') + ' on the same line removed (Undo if unwanted).' : ''));
  }

  function mergeNext() {
    var a = measures[selM], b = measures[selM + 1];
    if (!a || !b) return;
    if (!sameRow(a, b)) { say('The next measure is on another line; cannot merge.', true); return; }
    snap();
    var x = Math.min(a.x, b.x), x2 = Math.max(a.x + a.w, b.x + b.w);
    var y = Math.min(a.y, b.y), y2 = Math.max(a.y + a.h, b.y + b.h);
    measures.splice(selM, 2, { page: a.page, x: PP.r5(x), y: PP.r5(y), w: PP.r5(x2 - x), h: PP.r5(y2 - y) });
    rerender(); persist(); say('Merged.');
  }

  function deleteSel() {
    if (selM < 0) return;
    snap();
    measures.splice(selM, 1);
    selM = -1; rerender(); persist();
  }

  /* ---------- tapping ---------- */

  function flash(i) {
    var el = sheet.els[i];
    if (!el) return;
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }

  function tap(i) {
    var comp = parseFloat($('comp').value) || 0;
    var t = Math.round(Math.max(0, audio.currentTime - comp / 1000) * 1000) / 1000;
    snap();
    if (armed !== null) { events[armed] = { m: i + 1, t: t }; armed = null; }
    else events.push({ m: i + 1, t: t });
    events.sort(function (x, y) { return x.t - y.t; });
    renderList(); decorate(); updateButtons(); persist(); flash(i);
    say('Measure ' + (i + 1) + ' at ' + t.toFixed(3) + ' s');
  }

  function onMeasure(i, e, el) {
    if (mode === 'tap') { tap(i); return; }
    if (events.length) return;
    if (tool === 'split') { splitAt(i, e, el); return; }
    if (tool === 'addstaff' || tool === 'extend') return;   // handled on the sheet itself
    selM = i; decorate(); updateButtons();
    say('Measure ' + (i + 1) + ' selected.');
  }

  evBody.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    var k = parseInt(b.parentNode.parentNode.dataset.k, 10), act = b.dataset.act, ev = events[k];
    if (!ev) return;
    if (act === 'play') {
      audio.currentTime = Math.max(0, ev.t - 0.5);
      audio.play().catch(function () {});
    } else if (act === 'del') {
      snap(); events.splice(k, 1); armed = null; renderList(); decorate(); updateButtons(); persist();
    } else if (act === 'dn' || act === 'up') {
      snap();
      ev.t = Math.max(0, Math.round((ev.t + (act === 'up' ? 0.05 : -0.05)) * 1000) / 1000);
      events.sort(function (x, y) { return x.t - y.t; });
      renderList(); persist();
    } else if (act === 'retap') {
      armed = (armed === k) ? null : k;
      renderList();
      say(armed === null ? '' : 'Re-tap: click the measure now playing at the right time.');
    }
  });

  /* ---------- modes ---------- */

  function setMode(m) {
    mode = m; tool = null; armed = null; extendFrom = -1; drag = null;
    $('tabM').classList.toggle('on', m === 'measures');
    $('tabT').classList.toggle('on', m === 'tap');
    $('panelM').hidden = m !== 'measures';
    $('panelT').hidden = m !== 'tap';
    decorate(); updateButtons(); renderList();
    say(m === 'tap' ? 'Play the audio and click each measure as it begins.' : '');
  }
  $('tabM').addEventListener('click', function () { setMode('measures'); });
  $('tabT').addEventListener('click', function () { setMode('tap'); });
  $('delM').addEventListener('click', deleteSel);
  $('mergeM').addEventListener('click', mergeNext);
  $('splitM').addEventListener('click', function () { setTool('split'); });
  $('addS').addEventListener('click', function () { setTool('addstaff'); });
  $('extM').addEventListener('click', function () { setTool('extend'); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && tool && !PP.isTyping(e.target)) { setTool(tool); say(''); }
  });
  $('undo').addEventListener('click', undo);
  $('discard').addEventListener('click', function () {
    if (!piece || !confirm('Throw away your unsaved edits and taps and start again from piece.js?')) return;
    PP.safe.del(draftKey());
    open(piece.id);
  });
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !PP.isTyping(e.target)) { e.preventDefault(); undo(); }
  });
  $('clearT').addEventListener('click', function () {
    if (!events.length || !confirm('Delete all ' + events.length + ' taps?')) return;
    snap(); events = []; armed = null; renderList(); decorate(); updateButtons(); persist();
  });

  $('endT').addEventListener('change', function () {
    var v = parseFloat($('endT').value);
    endTime = isFinite(v) ? v : null; persist();
  });
  $('endNow').addEventListener('click', function () {
    endTime = Math.round(audio.currentTime * 100) / 100;
    $('endT').value = endTime; persist();
  });

  $('download').addEventListener('click', function () {
    if (!events.length) return;
    var end = endTime || (isFinite(audio.duration) ? Math.round(audio.duration * 100) / 100 : null);
    var last = events[events.length - 1].t;
    if (!end || end <= last) { say('End of piece must be later than the last tap (' + last.toFixed(2) + ' s).', true); return; }
    var text = PP.serialize({
      id: piece.id, title: piece.title, audio: piece.audio, pages: piece.pages,
      measures: measures, timeline: events, endTime: end
    });
    var url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    var a = document.createElement('a');
    a.href = url; a.download = 'piece.js';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    say('Downloaded. Replace pieces/' + piece.id + '/piece.js with it.');
  });

  /* ---------- playback frame loop ---------- */

  PP.bindTransport(audio, {
    onFrame: function (t) {
      var idx = PP.eventIndexAt(events, t);
      markCurrentRow(idx);
      var now = idx >= 0 ? events[idx].m - 1 : -1;
      if (now !== lastNow) {
        if (sheet && sheet.els[lastNow]) sheet.els[lastNow].classList.remove('now');
        if (sheet && sheet.els[now]) {
          sheet.els[now].classList.add('now');
          if (followCb.checked && mode === 'tap') PP.keepVisible(sheet.els[now], bar.offsetHeight);
        }
        lastNow = now;
      }
    }
  });
  audio.addEventListener('loadedmetadata', function () {
    if (endTime == null) { endTime = Math.round(audio.duration * 100) / 100; $('endT').value = endTime; }
  });
  audio.addEventListener('error', function () {
    if (piece) notice.hidden = false, notice.textContent = 'Could not load the audio file: ' + piece.base + piece.audio;
  });

  /* ---------- loading ---------- */

  function open(id) {
    audio.pause();
    notice.hidden = true;
    PP.loadPiece(id).then(function (p) {
      if (p.timeline.length) {
        piece = null;
        notice.hidden = false;
        notice.textContent = '"' + p.title + '" already has a timing table and cannot be edited here.';
        $('sheet').innerHTML = '';
        return;
      }
      piece = p;
      measures = p.measures.map(function (m) { return { page: m.page, x: m.x, y: m.y, w: m.w, h: m.h }; });
      events = []; endTime = null; history = []; selM = -1; armed = null; tool = null; extendFrom = -1;
      sheet = PP.buildSheet($('sheet'), p);
      pieceSig = sigOf(p.measures);
      var draft = PP.safe.get(draftKey());
      if (draft) {
        try {
          var d = JSON.parse(draft);
          if (d.sig === pieceSig && d.m && d.m.length) {
            measures = d.m; events = d.e || []; endTime = d.end;
            say('Draft restored (' + events.length + ' taps).');
          } else {
            PP.safe.del(draftKey());   // piece.js was regenerated since: the old draft no longer fits
            say('piece.js has changed since the last session, so the old draft was discarded.');
          }
        } catch (err) { PP.safe.del(draftKey()); }
      }
      audio.src = p.base + p.audio;
      rerender();
      setMode(events.length ? 'tap' : 'measures');
    }).catch(function (err) {
      notice.hidden = false; notice.textContent = String(err.message || err);
    });
  }

  function init() {
    var list = window.PIECE_LIST || [];
    if (!list.length) {
      notice.hidden = false;
      notice.textContent = 'No pieces yet. Run tools/prepare_piece.py first (see README.md).';
      return;
    }
    // offer only pieces that do not have a timing table yet
    var open_ = [];
    list.reduce(function (chain, p) {
      return chain.then(function () {
        return PP.loadPiece(p.id).then(function (d) { if (!d.timeline.length) open_.push(p); }, function () {});
      });
    }, Promise.resolve()).then(function () {
      if (!open_.length) {
        notice.hidden = false;
        notice.textContent = 'All pieces already have a timing table. Nothing to edit.';
        return;
      }
      open_.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.id; o.textContent = p.title || p.id;
        pieceSel.appendChild(o);
      });
      pieceSel.addEventListener('change', function () { open(pieceSel.value); });
      open(pieceSel.value);
    });
  }

  function sizeSide() { document.documentElement.style.setProperty('--bar-h', bar.offsetHeight + 'px'); }
  window.addEventListener('resize', sizeSide);
  sizeSide();
  init();
})();
