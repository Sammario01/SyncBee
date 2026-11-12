// public/branding.js
// Included on every page. It shows the SyncBee logo, applies the school's own colours, name and
// logo when they have set them, and ALWAYS shows the "Powered by Mariobee" badge. This file is
// not meant to be removed or bypassed by a school's customization.
(function () {
  'use strict';

  var DEFAULT_LOGO = '/img/logo.png';
  var HEX_POINTS = '50,3 93,26 93,74 50,97 7,74 7,26';
  var HEX_SELECTOR = 'svg polygon[points="' + HEX_POINTS + '"]';
  var currentLogo = DEFAULT_LOGO;

  // Browser tab / window icon
  if (!document.querySelector('link[rel~="icon"]')) {
    var link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/png';
    link.href = '/img/favicon.png';
    document.head.appendChild(link);
  }

  function makeLogo(size) {
    var img = document.createElement('img');
    img.setAttribute('data-brand-logo', '');
    img.alt = '';
    img.src = currentLogo;
    img.style.cssText = 'width:' + size.w + 'px;height:' + size.h + 'px;object-fit:contain;';
    return img;
  }

  // Replace the old hexagon placeholder wherever a page still has it
  function swapPlaceholders() {
    document.querySelectorAll(HEX_SELECTOR).forEach(function (poly) {
      var svg = poly.closest('svg');
      if (!svg) return;
      svg.replaceWith(makeLogo({ w: svg.getAttribute('width') || 28, h: svg.getAttribute('height') || 28 }));
    });
  }

  function setLogo(src) {
    currentLogo = src;
    swapPlaceholders();
    document.querySelectorAll('.brand-logo-slot').forEach(function (slot) {
      if (!slot.querySelector('img[data-brand-logo]')) {
        slot.textContent = '';
        slot.appendChild(makeLogo({ w: 28, h: 28 }));
      }
    });
    document.querySelectorAll('img[data-brand-logo]').forEach(function (img) { img.src = src; });
  }
    // Electron on Windows can leave text boxes frozen after alert()/confirm()/prompt().
  // The desktop app exposes syncbeeShell.refocus(); give the window its focus back after each dialog.
  if (window.syncbeeShell && window.syncbeeShell.refocus) {
    ['alert', 'confirm', 'prompt'].forEach(function (name) {
      var native = window[name];
      window[name] = function () {
        var result = native.apply(window, arguments);
        try { window.syncbeeShell.refocus(); } catch (e) { /* ignore */ }
        return result;
      };
    });
  }

  // Menus and sidebars are sometimes drawn after this script runs
  new MutationObserver(function () {
    if (document.querySelector(HEX_SELECTOR)) swapPlaceholders();
  }).observe(document.documentElement, { childList: true, subtree: true });

  function start() {
    swapPlaceholders();

    var badge = document.createElement('div');
    badge.style.cssText = 'position:fixed;bottom:10px;right:14px;font-size:11px;color:#8b96a3;font-family:sans-serif;z-index:9999;pointer-events:none;background:rgba(255,255,255,0.9);padding:2px 9px;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,0.08);';
    badge.textContent = 'Powered by Mariobee';
    document.body.appendChild(badge);

    fetch('/api/branding').then(function (r) { return r.json(); }).then(function (data) {
      var root = document.documentElement.style;
      if (data.color_primary) root.setProperty('--navy', data.color_primary);
      if (data.color_accent) root.setProperty('--orange', data.color_accent);
      if (data.color_success) root.setProperty('--emerald', data.color_success);

      document.querySelectorAll('.brand-name-text').forEach(function (el) {
        el.textContent = data.school_display_name || 'SyncBee';
      });
      if (data.logo_data_uri) setLogo(data.logo_data_uri);
    }).catch(function () { /* the defaults are fine */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();