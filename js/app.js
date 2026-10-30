/* app.js - practice page */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var audio = $('audio'), bar = $('bar'), statusEl = $('status'), notice = $('notice');
  var pieceSel = $('pieceSel'), loopCb = $('loop'), gapSel = $('gap'), followCb = $('follow');
  var occWrap = $('occWrap'), occSel = $('occ');

  var piece = null, sheet = null, tl = [];
  var sel = null;            // {a, b}: 0-based measure indices
  var awaitingEnd = false;   // true after the first click until the second
  var occ = 0, loop = null, lastNow = -2, waitTimer = null;

  function endTime() { return (piece && piece.endTime) || (isFinite(audio.duration) ? audio.duration : 0); }

  /* ---------- selection ---------- */

  function refresh() {
    if (!sheet) return;
    sheet.els.forEach(function (el, i) {
      el.classList.toggle('sel', !!sel && i >= sel.a && i <= sel.b);
    });
    loop = null;
    if (!sel) {
      occWrap.hidden = true;
      statusEl.textContent = tl.length ? 'Click a measure to start a selection.' : '';
      return;
    }
    var a = sel.a + 1, b = sel.b + 1;
    var occs = PP.occurrences(tl, a);
    occWrap.hidden = occs.length < 2;
    if (occs.length >= 2) {
      occSel.innerHTML = '';
      occs.forEach(function (ei, k) {
        var o = document.createElement('option');
        o.value = k;
        o.textContent = 'occurrence ' + (k + 1) + ' of ' + occs.length + ' (' + PP.fmt(tl[ei].t) + ')';
        occSel.appendChild(o);
      });
      occSel.value = String(Math.min(occ, occs.length - 1));
    }
    var label = a === b ? 'Measure ' + a : 'Measures ' + a + '–' + b;
    if (!tl.length) {
      statusEl.textContent = label + ' (this piece has no timing yet)';
    } else if (awaitingEnd) {
      loop = PP.resolveLoop(tl, endTime(), a, b, occ);
      statusEl.textContent = label + ' selected – click another measure to set the end, or press play to loop just this one.';
    } else {
      loop = PP.resolveLoop(tl, endTime(), a, b, occ);
      statusEl.textContent = loop
        ? label + ' · ' + PP.fmt(loop.start) + ' → ' + PP.fmt(loop.end) + ' (' + (loop.end - loop.start).toFixed(1) + ' s)'
        : label + ': no timing found for this range.';
    }
    if (awaitingEnd && !loop && tl.length) statusEl.textContent = label + ': no timing for this measure.';
  }

  function seekToLoop() { if (loop) audio.currentTime = loop.start; }

  function onMeasure(i) {
    if (!sel || !awaitingEnd) {
      sel = { a: i, b: i };
      awaitingEnd = true;
      occ = 0;
    } else {
      sel = { a: Math.min(sel.a, i), b: Math.max(sel.a, i) };
      awaitingEnd = false;
    }
    refresh();
    seekToLoop();
  }

  function clearSel() {
    sel = null; awaitingEnd = false; occ = 0; loop = null;
    clearTimeout(waitTimer); waitTimer = null;
    refresh();
  }

  occSel.addEventListener('change', function () { occ = parseInt(occSel.value, 10) || 0; refresh(); seekToLoop(); });
  $('clear').addEventListener('click', clearSel);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') clearSel(); });

  /* ---------- playback ---------- */

  function toggle() {
    clearTimeout(waitTimer); waitTimer = null;
    if (!audio.paused) { audio.pause(); return; }
    if (loop) {
      var t = audio.currentTime;
      if (t < loop.start - 0.05 || t >= loop.end) audio.currentTime = loop.start;
    }
    audio.play().catch(function () {});
  }

  function onFrame(t, playing) {
    // highlight the measure being played
    var idx = PP.eventIndexAt(tl, t);
    var now = idx >= 0 ? tl[idx].m - 1 : -1;
    if (now !== lastNow && sheet) {
      if (sheet.els[lastNow]) sheet.els[lastNow].classList.remove('now');
      if (sheet.els[now]) {
        sheet.els[now].classList.add('now');
        if (followCb.checked) PP.keepVisible(sheet.els[now], bar.offsetHeight);
      }
      lastNow = now;
    }
    // loop
    if (loop && playing && !waitTimer && t >= loop.end - 0.02 * audio.playbackRate && t < loop.end + 0.6) {
      if (!loopCb.checked) {
        audio.pause();
        audio.currentTime = loop.start;
      } else {
        var gap = parseFloat(gapSel.value) || 0;
        audio.currentTime = loop.start;
        if (gap > 0) {
          audio.pause();
          waitTimer = setTimeout(function () { waitTimer = null; audio.play().catch(function () {}); }, gap * 1000);
        }
      }
    }
  }

  PP.bindTransport(audio, { toggle: toggle, onFrame: onFrame });
  audio.addEventListener('loadedmetadata', refresh);
  audio.addEventListener('error', function () {
    if (piece) showNotice('Could not load the audio file: ' + piece.base + piece.audio);
  });

  /* ---------- loading a piece ---------- */

  function showNotice(msg) {
    notice.hidden = !msg;
    notice.textContent = msg || '';
  }

  function open(id) {
    clearSel();
    audio.pause();
    showNotice('');
    PP.loadPiece(id).then(function (p) {
      piece = p; tl = p.timeline; lastNow = -2;
      document.title = p.title + ' – Violin Practice';
      sheet = PP.buildSheet($('sheet'), p);
      sheet.render(p.measures, onMeasure);
      audio.src = p.base + p.audio;
      window.scrollTo(0, 0);
      if (!tl.length) showNotice('This piece has no timing yet, so playback cannot follow the measures. Add it with author.html.');
      refresh();
    }).catch(function (err) {
      showNotice(String(err.message || err));
    });
  }

  function init() {
    var list = window.PIECE_LIST || [];
    if (!list.length) {
      showNotice('No pieces yet. Add one with tools/prepare_piece.py (see README.md).');
      return;
    }
    list.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id; o.textContent = p.title || p.id;
      pieceSel.appendChild(o);
    });
    var want = decodeURIComponent(location.hash.slice(1));
    pieceSel.value = list.some(function (p) { return p.id === want; }) ? want : list[0].id;
    pieceSel.addEventListener('change', function () { location.hash = encodeURIComponent(pieceSel.value); open(pieceSel.value); });
    open(pieceSel.value);
  }
  init();
})();
