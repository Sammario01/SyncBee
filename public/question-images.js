// public/question-images.js
// Adds an "Add image" button to the Question Builder window: under every text area and next to
// every option box. The picked image is uploaded to this computer and an <img> tag is placed
// where the cursor was. Exam pages already show question and option text as HTML, so it appears
// there as a picture. If the page doesn't match, this does nothing and breaks nothing.
(function () {
  'use strict';

  var API = window.location.origin;
  var MAX_BYTES = 8 * 1024 * 1024;
  var TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

  var picker = null;
  var current = null; // { field, btn } that asked for an image

  function ensurePicker() {
    if (picker) return;
    picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = TYPES.join(',');
    picker.style.display = 'none';
    document.body.appendChild(picker);
    picker.addEventListener('change', onPicked);
  }

  // Messages appear next to the button (a native alert would freeze text boxes in the desktop app)
  function note(btn, text) {
    var old = btn.parentNode && btn.parentNode.querySelector('[data-img-note]');
    if (old) old.remove();
    var span = document.createElement('span');
    span.setAttribute('data-img-note', '');
    span.style.cssText = 'color:#DC2626;font-size:12px;margin-left:8px;';
    span.textContent = text;
    btn.insertAdjacentElement('afterend', span);
    setTimeout(function () { span.remove(); }, 6000);
  }

  function insertAtCursor(field, text) {
    var start = field.selectionStart;
    var end = field.selectionEnd;
    if (typeof start !== 'number') { start = end = field.value.length; }
    field.value = field.value.slice(0, start) + text + field.value.slice(end);
    try { field.setSelectionRange(start + text.length, start + text.length); } catch (e) { /* not all fields allow it */ }
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.focus();
  }

  async function onPicked() {
    var file = picker.files && picker.files[0];
    picker.value = '';
    if (!file || !current) return;
    var field = current.field;
    var btn = current.btn;

    if (TYPES.indexOf(file.type) === -1) { note(btn, 'Choose a PNG, JPG, GIF or WebP image.'); return; }
    if (file.size > MAX_BYTES) { note(btn, 'That image is larger than 8 MB.'); return; }

    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    try {
      var res = await fetch(API + '/api/uploads/question-image', {
        method: 'POST', headers: { 'Content-Type': file.type }, body: file
      });
      var data = {};
      try { data = await res.json(); } catch (e) { /* no body */ }
      if (!res.ok) throw new Error(data.error || data.message || 'The image could not be uploaded.');
      insertAtCursor(field, '<img src="' + data.url + '" style="max-width:100%;height:auto;" alt="">');
    } catch (err) {
      note(btn, err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  function addButton(field, small) {
    if (field.getAttribute('data-img-ready')) return;
    field.setAttribute('data-img-ready', '1');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost';
    btn.textContent = small ? '🖼' : '🖼 Add image';
    btn.title = 'Insert an image';
    btn.style.cssText = small ? 'padding:4px 10px;font-size:13px;flex-shrink:0;' : 'padding:5px 12px;font-size:12px;margin-top:6px;';
    btn.addEventListener('click', function () {
      ensurePicker();
      current = { field: field, btn: btn };
      picker.click();
    });
    field.insertAdjacentElement('afterend', btn);
  }

  function scan() {
    document.querySelectorAll('.modal-box textarea').forEach(function (t) { addButton(t, false); });
    document.querySelectorAll('.modal-box .option-row input[type="text"]').forEach(function (i) { addButton(i, true); });
  }

  function start() {
    scan();
    // Option rows and the window itself are drawn when needed
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();