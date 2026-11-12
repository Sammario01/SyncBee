(function () {
  // ── Config ─────────────────────────────────────────────────────────
  // Adjust to match your /branding.js endpoint.
  const BRANDING_ENDPOINT = '/api/system/branding';
  const LOGIN_REDIRECT    = '/login';

  const DEFAULTS = {
    school_name:   'SyncBee',
    logo_url:      './img/syncbee.png',
    primary_color: '#0F2647',
    accent_color:  '#F5941F',
    show_name:     true
  };

  // ── Helpers ────────────────────────────────────────────────────────
  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
  }

  function isLight(hex) {
    const h = (hex || '').replace('#', '');
    if (h.length !== 6) return false;
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
  }

  async function fetchJson(url, fallback) {
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) return fallback;
      return await res.json();
    } catch (_) {
      return fallback;
    }
  }

  // ── Inject minimal topbar styles (scoped, no collisions) ───────────
  function injectStyles() {
    if (document.getElementById('syncbee-topbar-styles')) return;
    const style = document.createElement('style');
    style.id = 'syncbee-topbar-styles';
    style.textContent = `
      .syncbee-topbar {
        position: sticky;
        top: 0;
        z-index: 50;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 28px;
        font-family: 'Manrope', system-ui, sans-serif;
        box-shadow: 0 1px 0 rgba(0,0,0,0.06), 0 2px 10px rgba(15,38,71,0.06);
      }
      .syncbee-topbar .sb-brand {
        display: flex;
        align-items: center;
        gap: 10px;
        font-family: 'Poppins', sans-serif;
        font-weight: 700;
        font-size: 18px;
        letter-spacing: -0.2px;
        min-width: 0;
      }
      .syncbee-topbar .sb-brand img {
        height: 30px;
        width: auto;
        display: block;
        border-radius: 6px;
        flex-shrink: 0;
      }
      .syncbee-topbar .sb-brand span {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .syncbee-topbar .sb-right {
        display: flex;
        align-items: center;
        gap: 16px;
      }
      .syncbee-topbar .sb-welcome {
        font-size: 14px;
        font-weight: 500;
        opacity: 0.85;
        max-width: 260px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .syncbee-topbar .sb-logout {
        background: transparent;
        border: 1px solid currentColor;
        color: inherit;
        padding: 8px 16px;
        border-radius: 10px;
        font-size: 13px;
        font-weight: 600;
        font-family: 'Manrope', sans-serif;
        cursor: pointer;
        opacity: 0.85;
        transition: opacity .15s ease, background .15s ease;
        white-space: nowrap;
      }
      .syncbee-topbar .sb-logout:hover {
        opacity: 1;
        background: rgba(255,255,255,0.12);
      }
      @media (max-width: 560px) {
        .syncbee-topbar { padding: 12px 16px; }
        .syncbee-topbar .sb-welcome { display: none; }
        .syncbee-topbar .sb-brand span { font-size: 16px; }
      }
    `;
    document.head.appendChild(style);
  }

  // ── Build & inject the topbar once ─────────────────────────────────
  function ensureTopbar() {
    let bar = document.querySelector('.syncbee-topbar');
    if (bar) return bar;

    bar = document.createElement('div');
    bar.className = 'syncbee-topbar';
    bar.innerHTML = `
      <div class="sb-brand">
        <span class="sb-logo-slot"></span>
        <span class="sb-name"></span>
      </div>
      <div class="sb-right">
        <span class="sb-welcome" id="welcomeMsg"></span>
        <button type="button" class="sb-logout" id="logoutBtn">Log Out</button>
      </div>
    `;

    // Insert at the very top of <body>
    document.body.insertBefore(bar, document.body.firstChild);

    // Wire logout
    bar.querySelector('#logoutBtn').addEventListener('click', async () => {
      try {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      } catch (_) {}
      window.location.href = LOGIN_REDIRECT;
    });

    return bar;
  }

  // ── Apply branding to the topbar ──────────────────────────────────
  function paintTopbar(branding) {
    const bar = ensureTopbar();
    const light = isLight(branding.primary_color);
    const textColor  = light ? '#0F2647' : '#FFFFFF';
    const mutedColor = light ? 'rgba(15,38,71,0.6)' : 'rgba(255,255,255,0.8)';

    bar.style.background = branding.primary_color;
    bar.style.color = textColor;

    // Logo
    const logoSlot = bar.querySelector('.sb-logo-slot');
    logoSlot.innerHTML = branding.logo_url
      ? `<img src="${escapeHtml(branding.logo_url)}" alt="${escapeHtml(branding.school_name)} logo"
              onerror="this.style.display='none'">`
      : `<svg width="30" height="30" viewBox="0 0 100 100">
           <polygon points="50,3 93,26 93,74 50,97 7,74 7,26" fill="${escapeHtml(branding.accent_color)}"/>
           <text x="50" y="66" font-family="Poppins,sans-serif" font-weight="700"
                 font-size="48" fill="${escapeHtml(branding.primary_color)}" text-anchor="middle">S</text>
         </svg>`;

    // Name
    const nameEl = bar.querySelector('.sb-name');
    if (branding.show_name === false) {
      nameEl.style.display = 'none';
    } else {
      nameEl.style.display = '';
      nameEl.textContent = branding.school_name || 'SyncBee';
    }

    // Welcome styling
    const welcome = bar.querySelector('#welcomeMsg');
    if (welcome) welcome.style.color = mutedColor;

    // Expose primary color as CSS var for the rest of the page
    document.documentElement.style.setProperty('--navy', branding.primary_color);
    document.documentElement.style.setProperty('--orange', branding.accent_color);
  }

  // ── Boot sequence ─────────────────────────────────────────────────
  async function boot() {
    injectStyles();
    ensureTopbar();                       // show immediately with defaults

    // Fetch branding + user in parallel
    const [branding, me] = await Promise.all([
      fetchJson(BRANDING_ENDPOINT, DEFAULTS),
      fetchJson('/api/auth/me', { success: false })
    ]);

    // Merge defaults so missing keys don't blank anything out
    const merged = { ...DEFAULTS, ...branding };
    paintTopbar(merged);

    if (!me.success) {
      window.location.href = LOGIN_REDIRECT;
      return;
    }

    const welcome = document.getElementById('welcomeMsg');
    if (welcome) welcome.textContent = me.full_name || '';

    // Re-apply muted color in case paintTopbar ran before welcome had text
    const light = isLight(merged.primary_color);
    if (welcome) welcome.style.color = light ? 'rgba(15,38,71,0.6)' : 'rgba(255,255,255,0.8)';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();