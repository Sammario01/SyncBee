// public/replay-logger.js
// Records a timestamped event stream for the exam being taken so an administrator
// can replay it later. It must NEVER break the exam, so everything is guarded.
(function () {
  'use strict';

  const API = window.location.origin;
  const KEY_PREFIX = 'syncbee_events_';
  const FLUSH_MS = 4000;
  const MAX_QUEUE = 3000;
  const MAX_BATCH_EVENTS = 100;
  const MAX_BATCH_CHARS = 60000;
  const VALUE_CAP = 5000;
  const THEORY_DEBOUNCE_MS = 1500;

  const origFetch = window.fetch.bind(window);

  let attemptId = null;
  let queue = [];
  let counter = 0;
  let flushing = false;
  let unloading = false;
  let started = false;
  let lastQuestionId = null;
  let everFullscreen = false;
  let fullscreenLost = false;
  let tabHidden = false;
  let failCount = 0;
  let firstFailAt = 0;
  let connectionLost = false;
  const pendingTheory = {};

  function safe(fn) {
    return function () {
      try { return fn.apply(this, arguments); } catch (e) { /* ignore */ }
    };
  }

  function makeUid() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    const rand = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${Date.now().toString(36)}-${(++counter).toString(36)}-${rand}`;
  }

  function cap(value) {
    if (value === undefined || value === null) return null;
    const s = String(value);
    return s.length > VALUE_CAP ? s.slice(0, VALUE_CAP) : s;
  }

  function storageKey(id) { return KEY_PREFIX + id; }

  function saveQueue() {
    try {
      if (queue.length) localStorage.setItem(storageKey(attemptId), JSON.stringify(queue));
      else localStorage.removeItem(storageKey(attemptId));
    } catch (e) { /* storage full or blocked: events still go out from memory */ }
  }

  const log = safe(function (type, data, questionId, at) {
    if (!attemptId) return;
    if (queue.length >= MAX_QUEUE) queue.shift(); // never grow without bound
    queue.push({
      uid: makeUid(), type,
      question_id: questionId || null,
      data: data === undefined ? null : data,
      ts: at || Date.now()
    });
    saveQueue();
  });

  function takeBatch(list) {
    const batch = [];
    let chars = 0;
    for (const e of list) {
      const size = JSON.stringify(e).length;
      if (batch.length && (batch.length >= MAX_BATCH_EVENTS || chars + size > MAX_BATCH_CHARS)) break;
      batch.push(e);
      chars += size;
    }
    return batch;
  }

  // Returns the events that no longer need to be kept (delivered, or permanently rejected).
  async function sendBatch(id, list, useBeacon) {
    const batch = takeBatch(list);
    if (!batch.length) return [];
    const body = JSON.stringify({ sent_at: Date.now(), events: batch });
    const url = `${API}/api/attempts/${encodeURIComponent(id)}/events`;

    if (useBeacon && navigator.sendBeacon) {
      // Fire-and-forget while the page is leaving. They stay queued and are re-sent
      // later; the server ignores duplicates, so nothing is lost or doubled.
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      return [];
    }

    try {
      const res = await window.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: body.length < 60000
      });
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
      if (res.ok || permanent) return batch;
    } catch (e) { /* offline: keep them for the next attempt */ }
    return [];
  }

  const flush = safe(async function (useBeacon) {
    if (!attemptId || !queue.length) return;
    if (flushing && !useBeacon) return;
    flushing = true;
    try {
      const done = await sendBatch(attemptId, queue, useBeacon);
      if (done.length) {
        const gone = new Set(done.map(e => e.uid));
        queue = queue.filter(e => !gone.has(e.uid));
        saveQueue();
        if (queue.length) setTimeout(() => flush(false), 0);
      }
    } finally {
      flushing = false;
    }
  });

  // Events left behind by a previous exam page (e.g. the student moved to the next exam in a bundle).
  const flushOrphans = safe(async function () {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(KEY_PREFIX) && k.slice(KEY_PREFIX.length) !== attemptId) keys.push(k);
    }
    for (const key of keys) {
      const id = key.slice(KEY_PREFIX.length);
      let list = [];
      try { list = JSON.parse(localStorage.getItem(key)) || []; } catch (e) { localStorage.removeItem(key); continue; }
      let guard = 0;
      while (list.length && guard++ < 20) {
        const done = await sendBatch(id, list, false);
        if (!done.length) break;
        const gone = new Set(done.map(e => e.uid));
        list = list.filter(e => !gone.has(e.uid));
      }
      if (list.length) localStorage.setItem(key, JSON.stringify(list));
      else localStorage.removeItem(key);
    }
  });

  // ── Connection tracking: every request the page makes doubles as a probe ──
  function noteFailure() {
    if (unloading) return;
    if (!failCount) firstFailAt = Date.now();
    failCount++;
    if (failCount >= 2 && !connectionLost) {
      connectionLost = true;
      log('connection_lost', { source: 'request_failed' }, null, firstFailAt);
    }
  }

  function noteSuccess() {
    if (connectionLost) {
      log('connection_restored', { outage_ms: Date.now() - firstFailAt });
      connectionLost = false;
    }
    failCount = 0;
  }

  window.fetch = function () {
    return origFetch.apply(window, arguments).then(
      function (res) { try { noteSuccess(); } catch (e) {} return res; },
      function (err) { try { noteFailure(); } catch (e) {} throw err; }
    );
  };

  window.addEventListener('offline', safe(function () {
    if (unloading || connectionLost) return;
    connectionLost = true;
    failCount = 2;
    firstFailAt = Date.now();
    log('connection_lost', { source: 'browser_offline' });
  }));

  document.addEventListener('visibilitychange', safe(function () {
    if (unloading) return;
    if (document.hidden) {
      tabHidden = true;
      log('tab_hidden');
      flush(true);
    } else if (tabHidden) {
      tabHidden = false;
      log('tab_visible');
      flush(false);
    }
  }));

  document.addEventListener('fullscreenchange', safe(function () {
    if (unloading) return;
    if (document.fullscreenElement) {
      if (!everFullscreen) { everFullscreen = true; log('fullscreen_entered'); }
      else if (fullscreenLost) { fullscreenLost = false; log('fullscreen_restored'); }
    } else if (everFullscreen) {
      fullscreenLost = true;
      log('fullscreen_lost');
    }
  }));

  function settlePendingTheory() {
    Object.keys(pendingTheory).forEach(function (qid) {
      const p = pendingTheory[qid];
      clearTimeout(p.timer);
      delete pendingTheory[qid];
      answerChanged(qid, p.old, p.latest);
    });
  }

  window.addEventListener('pagehide', safe(function () {
    settlePendingTheory();
    unloading = true;
    flush(true);
  }));
  window.addEventListener('pageshow', function (e) { if (e.persisted) unloading = false; });

  // ── What the exam page calls ──
  const questionOpened = safe(function (qid) {
    if (!qid || qid === lastQuestionId) return; // re-renders of the same question aren't new events
    lastQuestionId = qid;
    log('question_opened', null, qid);
  });

  const answerChanged = safe(function (qid, oldVal, newVal) {
    if (oldVal === newVal) return;
    const hadOld = oldVal !== undefined && oldVal !== null && oldVal !== '';
    const hasNew = newVal !== undefined && newVal !== null && newVal !== '';
    const type = !hadOld ? 'answer_selected' : (hasNew ? 'answer_changed' : 'answer_cleared');
    log(type, { old: hadOld ? cap(oldVal) : null, new: hasNew ? cap(newVal) : null }, qid);
  });

  // Typed answers: one event per pause in typing, not one per keystroke.
  const theoryTyped = safe(function (qid, prev, text) {
    let p = pendingTheory[qid];
    if (!p) p = pendingTheory[qid] = { old: prev, latest: text, timer: null };
    p.latest = text;
    clearTimeout(p.timer);
    p.timer = setTimeout(function () {
      const done = pendingTheory[qid];
      delete pendingTheory[qid];
      if (done) answerChanged(qid, done.old, done.latest);
    }, THEORY_DEBOUNCE_MS);
  });

  const beforeNavigate = safe(function () {
    settlePendingTheory();
    unloading = true;
    flush(true);
  });

  const init = safe(function (id) {
    if (started || !id) return;
    started = true;
    attemptId = id;
    try {
      queue = JSON.parse(localStorage.getItem(storageKey(id)) || '[]');
      if (!Array.isArray(queue)) queue = [];
    } catch (e) { queue = []; }

    let navigation = 'navigate';
    try {
      const entry = performance.getEntriesByType('navigation')[0];
      if (entry && entry.type) navigation = entry.type; // 'navigate' | 'reload' | 'back_forward'
    } catch (e) {}
    log('page_loaded', { navigation });

    setInterval(function () { flush(false); }, FLUSH_MS);
    setTimeout(flushOrphans, 2500);
  });

  window.ReplayLogger = {
    init, log, questionOpened, answerChanged, theoryTyped, beforeNavigate,
    flushNow: function () { return flush(false); }
  };
})();