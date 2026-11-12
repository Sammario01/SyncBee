(function () {
  const path = window.location.pathname;

  // ── Navigation structure ────────────────────────────────────────────
  // Each entry is either a standalone link { href, label, icon }
  // or a group { label, icon, children: [...] }.
  const NAV = [
    { href: '/admin-dashboard', label: 'Dashboard', icon: 'grid' },

    {
      label: 'Content', icon: 'book', key: 'content',
      children: [
        { href: '/admin-exams',    label: 'Exams',    icon: 'book' },
        { href: '/admin-bundles',  label: 'Bundles',  icon: 'box' },
        { href: '/admin-features', label: 'Features', icon: 'star' },
        { href: '/admin-catalog',  label: 'Catalog',  icon: 'list' }
      ]
    },

    {
      label: 'People', icon: 'users', key: 'people',
      children: [
        { href: '/admin-students', label: 'Students', icon: 'users' },
        { href: '/admin-grading',  label: 'Grading',  icon: 'check' }
      ]
    },

    {
      label: 'Live Ops', icon: 'eye', key: 'liveops',
      children: [
        { href: '/admin-monitor',   label: 'Monitor',   icon: 'eye' },
        { href: '/admin-heatmap',   label: 'Heatmap',   icon: 'heatmap' },
        { href: '/admin-incidents', label: 'Incidents', icon: 'alert' },
        { href: '/admin-replays',   label: 'Replay',    icon: 'play' },
        { href: '/admin-devices',   label: 'Device',    icon: 'monitor' }
      ]
    },

    {
      label: 'Insights', icon: 'trending', key: 'insights',
      children: [
        { href: '/admin-results',   label: 'Results',   icon: 'chart' },
        { href: '/admin-analytics', label: 'Analytics', icon: 'trending' }
      ]
    },

    {
      label: 'System', icon: 'settings', key: 'system',
      children: [
        { href: '/admin-license',  label: 'License',  icon: 'key' },
        { href: '/sync',           label: 'Sync',     icon: 'refresh' },
        { href: '/admin-branding', label: 'Settings', icon: 'settings' }
      ]
    }
  ];

  // ── Icons ───────────────────────────────────────────────────────────
  const icons = {
    grid:     '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
    book:     '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    box:      '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
    star:     '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    users:    '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    list:     '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
    eye:      '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    heatmap:  '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="6" y="6" width="4" height="4" fill="currentColor" stroke="none" opacity="0.35"/><rect x="14" y="6" width="4" height="4" fill="currentColor" stroke="none" opacity="0.85"/><rect x="6" y="14" width="4" height="4" fill="currentColor" stroke="none" opacity="0.6"/><rect x="14" y="14" width="4" height="4" fill="currentColor" stroke="none" opacity="1"/>',
    chart:    '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
    trending: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
    alert:    '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    check:    '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    monitor:  '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
    play:     '<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>',
    key:      '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
    refresh:  '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    chevron:  '<polyline points="6 9 12 15 18 9"/>'
  };

  function iconSVG(name, cls) {
    return `<svg class="nav-icon${cls ? ' ' + cls : ''}" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || ''}</svg>`;
  }

  // ── Build nav HTML ──────────────────────────────────────────────────
  const GROUP_STATE_KEY = 'syncbee_sidebar_groups';

  function loadGroupState() {
    try { return JSON.parse(localStorage.getItem(GROUP_STATE_KEY)) || {}; }
    catch (_) { return {}; }
  }
  function saveGroupState(state) {
    try { localStorage.setItem(GROUP_STATE_KEY, JSON.stringify(state)); } catch (_) {}
  }

  const groupState = loadGroupState();

  function renderNav() {
    return NAV.map(item => {
      // Standalone link
      if (item.href) {
        const active = path === item.href;
        return `<a href="${item.href}"${active ? ' class="active"' : ''}>${iconSVG(item.icon)}<span>${item.label}</span></a>`;
      }

      // Group
      const containsActive = item.children.some(c => c.href === path);

      // Determine open/closed: user preference wins, but auto-open if a
      // child is the current page (unless the user explicitly closed it
      // while on this page — edge case, but we honour an explicit close).
      let open;
      if (containsActive) {
        open = groupState[item.key] !== false; // default open if not explicitly closed
      } else {
        open = groupState[item.key] === true;  // default closed
      }

      const children = item.children.map(c => {
        const active = path === c.href;
        return `<a href="${c.href}" class="nav-child${active ? ' active' : ''}">${iconSVG(c.icon)}<span>${c.label}</span></a>`;
      }).join('');

      return `
        <div class="nav-group${open ? ' open' : ''}" data-key="${item.key}">
          <button type="button" class="nav-group-toggle${containsActive ? ' has-active' : ''}" aria-expanded="${open}">
            ${iconSVG(item.icon)}
            <span>${item.label}</span>
            ${iconSVG('chevron', 'nav-caret')}
          </button>
          <div class="nav-group-children">${children}</div>
        </div>
      `;
    }).join('');
  }

  const html = `
    <div class="brand">
      <span class="brand-logo-slot" style="background:white;">
        <img class="img" height="35" width="34" src="./img/syncbee.png" alt="SyncBee Logo">
      </span>
      <span class="brand-name-text">SyncBee</span>
    </div>
    <nav class="sidebar-nav">${renderNav()}</nav>
    <button type="button" id="sidebar-logout" class="sidebar-logout">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round"
           stroke-linejoin="round" style="vertical-align:-3px; margin-right:8px;">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
        <polyline points="16 17 21 12 16 7"/>
        <line x1="21" y1="12" x2="9" y2="12"/>
      </svg>
      Logout
    </button>
  `;

  const slot = document.getElementById('sidebar-slot');
  const target = slot || document.querySelector('.sidebar');
  if (target) {
    target.classList.add('sidebar');
    target.innerHTML = html;
  }

  // ── Wire group toggles ──────────────────────────────────────────────
  target?.querySelectorAll('.nav-group-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.closest('.nav-group');
      const key = group.dataset.key;
      const nowOpen = !group.classList.contains('open');
      group.classList.toggle('open', nowOpen);
      btn.setAttribute('aria-expanded', String(nowOpen));
      groupState[key] = nowOpen;
      saveGroupState(groupState);
    });
  });

  function askConfirm(message, okLabel) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,38,71,.55);display:flex;align-items:center;justify-content:center;z-index:10000;';
    const box = document.createElement('div');
    box.style.cssText = "background:#fff;border-radius:14px;padding:24px 26px;max-width:340px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,.25);font-family:'Manrope',sans-serif;";
    const text = document.createElement('div');
    text.style.cssText = 'font-size:15px;font-weight:600;color:#0F2647;margin-bottom:18px;line-height:1.4;';
    text.textContent = message;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'btn btn-ghost'; cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'button'; ok.className = 'btn btn-primary'; ok.textContent = okLabel || 'OK';
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(false); } };
    const done = (value) => { document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(value); };
    cancel.onclick = () => done(false);
    ok.onclick = () => done(true);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    document.addEventListener('keydown', onKey, true);
    row.append(cancel, ok);
    box.append(text, row);
    overlay.append(box);
    document.body.appendChild(overlay);
    ok.focus();
  });
}

  // ── Logout ──────────────────────────────────────────────────────────
  const logoutBtn = document.getElementById('sidebar-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      if (!(await askConfirm('Log out of SyncBee?', 'Log out'))) return;
      try {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      } catch (e) {}
      window.location.href = '/admin-login';
    });
  }

  // ── Environment banner ──────────────────────────────────────────────
  function injectBanner(info) {
    if (document.getElementById('env-banner')) return;

    let bg, color, icon, message;
    switch (info.license_state) {
      case 'expired':
        bg = '#FEF2F2'; color = '#DC2626'; icon = '🔴';
        message = 'SyncBee — License expired. Contact Mariobee to renew.';
        break;
      case 'expiring':
        bg = '#FEFCE8'; color = '#CA8A04'; icon = '🟡';
        message = `SyncBee — License expires in ${info.license_days_left} day${info.license_days_left === 1 ? '' : 's'}`;
        break;
      case 'unlicensed':
        bg = '#FEF2F2'; color = '#DC2626'; icon = '🔴';
        message = 'SyncBee — No license installed.';
        break;
      case 'licensed':
      default:
        bg = '#ECFDF5'; color = '#10B981'; icon = '🟢';
        message = info.school_name
          ? `SyncBee — Licensed to ${info.school_name}`
          : 'SyncBee — Licensed';
        break;
    }

    if (info.dev) message += `  ·  [DEV v${info.version}]`;

    const bar = document.createElement('div');
    bar.id = 'env-banner';
    bar.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 26px;
      background: ${bg};
      color: ${color};
      font: 600 11px/26px 'Manrope', sans-serif;
      letter-spacing: 0.5px;
      text-align: center;
      z-index: 9999;
      border-bottom: 1px solid ${color}33;
      pointer-events: none;
    `;
    bar.textContent = `${icon} ${message}`;
    document.body.appendChild(bar);
  }

  fetch('/api/system/environment')
    .then(r => r.ok ? r.json() : null)
    .then(data => { if (data) injectBanner(data); })
    .catch(() => {});

  // ── Floating help-request widget ────────────────────────────────────
  const HELP_POLL_MS   = 20000;
  const HELP_COLLAPSED = 'syncbee_help_widget_collapsed';

  let helpWidgetEl  = null;
  let helpPollTimer = null;
  let helpState     = { pending_count: 0, requests: [] };
  let helpCollapsed = localStorage.getItem(HELP_COLLAPSED) === '1';

  function helpWaitLabel(seconds) {
    if (seconds === null || seconds === undefined) return '—';
    if (seconds < 60)    return `${seconds}s`;
    if (seconds < 3600)  return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  }

  function helpSeverityClass(count) {
    if (count === 0) return 'zero';
    if (count <= 2)  return 'low';
    if (count <= 4)  return 'medium';
    return 'high';
  }

  function renderHelpWidget() {
    if (helpState.pending_count === 0) {
      if (helpWidgetEl && helpWidgetEl.parentNode) helpWidgetEl.parentNode.removeChild(helpWidgetEl);
      helpWidgetEl = null;
      return;
    }

    if (!helpWidgetEl) {
      helpWidgetEl = document.createElement('div');
      helpWidgetEl.id = 'help-widget';
      document.body.appendChild(helpWidgetEl);

      helpWidgetEl.addEventListener('click', () => {
        if (helpCollapsed) {
          helpCollapsed = false;
          localStorage.setItem(HELP_COLLAPSED, '0');
          renderHelpWidget();
        }
      });
    }

    const sev = helpSeverityClass(helpState.pending_count);
    helpWidgetEl.className = `help-widget sev-${sev}${helpCollapsed ? ' collapsed' : ''}`;

    if (helpCollapsed) {
      helpWidgetEl.innerHTML = `
        <div class="help-collapsed-pill">
          🖐 <strong>${helpState.pending_count}</strong>
        </div>`;
      return;
    }

    const rows = helpState.requests.map(r => `
      <div class="help-widget-row" data-id="${r.id}">
        <span class="help-widget-hand">🖐</span>
        <span class="help-widget-name">${escapeHtml(r.name)}</span>
        <span class="help-widget-code">${escapeHtml(r.exam_code)}</span>
        <span class="help-widget-wait">${helpWaitLabel(r.wait_seconds)}</span>
      </div>`).join('');

    helpWidgetEl.innerHTML = `
      <div class="help-widget-head">
        <span class="help-widget-title">
          🖐 ${helpState.pending_count} student${helpState.pending_count === 1 ? '' : 's'} need${helpState.pending_count === 1 ? 's' : ''} help
        </span>
        <button class="help-widget-collapse" title="Collapse">–</button>
      </div>
      <div class="help-widget-list">${rows}</div>
      <div class="help-widget-foot">
        <a href="/admin-monitor">Open Monitor →</a>
      </div>`;

    const collapseBtn = helpWidgetEl.querySelector('.help-widget-collapse');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        helpCollapsed = true;
        localStorage.setItem(HELP_COLLAPSED, '1');
        renderHelpWidget();
      });
    }
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
  }

  async function pollHelpWidget() {
    try {
      const res = await fetch('/api/dashboard/help-requests', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      helpState = {
        pending_count: data.pending_count || 0,
        requests: data.requests || []
      };
      renderHelpWidget();
    } catch (_) {}
  }

  pollHelpWidget();
  helpPollTimer = setInterval(pollHelpWidget, HELP_POLL_MS);
})();