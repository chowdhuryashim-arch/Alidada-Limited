/* ALIDADA Limited Ledger Book — single-page app (vanilla JS, no build step). */
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const cents = (n) => Math.round(Number(n) * 100);
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem('adl.' + k);
        return v === null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem('adl.' + k, JSON.stringify(v));
      } catch {
        /* storage unavailable — preference is simply not remembered */
      }
    },
  };

  const S = {
    me: null,
    company: 'ALIDADA Limited',
    currency: '৳',
    counts: { unread: 0, toApprove: 0, toPost: 0 },
    data: null,
    users: null,
    notifications: null,
    audit: null,
    limitHistory: null,
    view: null,
    txFilters: { q: '', status: 'active', type: '', account: '', category: '', tag: '' },
    period: store.get('period', 'this_month'),
    customFrom: store.get('customFrom', null),
    customTo: store.get('customTo', null),
    approvalsTab: null,
  };

  function money(n, { sign = false } = {}) {
    const v = Number(n) || 0;
    const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const pre = v < 0 ? '−' : sign && v > 0 ? '+' : '';
    // Word joiner keeps a minus or plus sign on the same line as the amount.
    return `${pre}${pre ? '\u2060' : ''}${S.currency}\u00a0${s}`;
  }
  function compact(n) {
    const a = Math.abs(n);
    if (a >= 1e7) return (n / 1e6).toFixed(0) + 'M';
    if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e4) return (n / 1e3).toFixed(0) + 'K';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }
  const fmtDateTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const todayDMY = () => {
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  };
  const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  class ApiError extends Error {
    constructor(message, status, data) {
      super(message);
      this.status = status;
      this.data = data;
    }
  }
  async function api(path, { method = 'GET', body, raw } = {}) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      if (raw) opts.body = body;
      else {
        opts.headers['content-type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
    }
    const res = await fetch(path, opts);
    if (res.status === 401) {
      location.href = '/login';
      throw new ApiError('Please sign in.', 401, {});
    }
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* non-JSON */
    }
    if (!res.ok || data.ok === false) throw new ApiError(data.error || data.message || `Request failed (${res.status})`, res.status, data);
    return data;
  }

  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 6000 : 4000);
  }

  // ---------------------------------------------------------------------------
  // Icons — hand-built inline SVG, 24×24, stroke style
  // ---------------------------------------------------------------------------
  const ICONS = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    approve: '<path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2M16 7l3 3M19 4l2 2"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    transfer: '<path d="M17 3l4 4-4 4M3 7h18M7 21l-4-4 4-4M21 17H3"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    wallet: '<path d="M20 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V5"/><path d="M17 14h.01"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
    reject: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>',
    edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    loan: '<path d="M2 12h3l3-2h4a2 2 0 0 1 0 4H9"/><path d="M5 18h9l6-5a1.6 1.6 0 0 0-2.3-2.2L14 14"/><circle cx="16" cy="5" r="3"/>',
    csv: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14l3 3 3-3"/>',
  };
  const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  // ---------------------------------------------------------------------------
  // Domain vocabulary
  // ---------------------------------------------------------------------------
  const TYPE_LABEL = { expense: 'Expense', receive: 'Receive Fund', transfer: 'Transfer', loan_given: 'Loan given', loan_recovery: 'Loan recovery' };
  const isLoan = (t) => t.kind === 'loan_given' || t.kind === 'loan_recovery';
  // The company account a loan entry paid from or received into.
  const loanCashAccount = (t) => (t.kind === 'loan_given' ? t.account : t.toAccount);
  const STATUS_LABEL = {
    posted: 'Posted',
    pending_approval: 'Pending approval',
    approved: 'Approved · awaiting posting',
    rejected: 'Rejected',
    cancelled: 'Withdrawn',
  };
  const STATUS_ICON = { posted: 'check', pending_approval: 'clock', approved: 'send', rejected: 'reject', cancelled: 'x' };
  const ROLE_LABEL = { admin: 'Admin', superuser: 'Super User', miduser: 'Mid User', user: 'User' };
  const EVENT_LABEL = {
    initiated: 'Initiated',
    auto_posted: 'Posted automatically (within limit)',
    submitted: 'Sent for approval',
    approved: 'Approved',
    rejected: 'Rejected',
    posted: 'Final posting completed',
    cancelled: 'Withdrawn by initiator',
    rerouted: 'Re-routed to another approver',
    edited: 'Details edited',
  };
  const PETTY_CASH = 'Petty Cash';
  const ACTIVE_STATUSES = ['posted', 'pending_approval', 'approved'];
  const statusChip = (s) => `<span class="chip ${s}">${icon(STATUS_ICON[s])}${esc(STATUS_LABEL[s] || s)}</span>`;
  const isFinancial = () => S.me && S.me.role !== 'admin';
  const isSuper = () => S.me && S.me.role === 'superuser';
  // Mid Users and Super Users may add categories and tags.
  const canManageLists = () => S.me && (S.me.role === 'superuser' || S.me.role === 'miduser');
  const userName = (id) => {
    if (!id) return '—';
    if (id === S.me.id) return `${S.me.fullName} (you)`;
    const u = (S.data?.directory || []).find((x) => x.id === id) || (S.users || []).find((x) => x.id === id);
    return u ? u.fullName : 'Unknown user';
  };

  // Periods
  const PERIODS = [
    ['all', 'All time'],
    ['this_month', 'This month'],
    ['last_month', 'Last month'],
    ['last_3', 'Last 3 months'],
    ['last_6', 'Last 6 months'],
    ['this_year', 'This year'],
    ['custom', 'Custom range…'],
  ];
  function periodRange(p) {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const first = (yy, mm) => isoLocal(new Date(yy, mm, 1));
    const last = (yy, mm) => isoLocal(new Date(yy, mm + 1, 0));
    switch (p) {
      case 'this_month': return [first(y, m), last(y, m)];
      case 'last_month': return [first(y, m - 1), last(y, m - 1)];
      case 'last_3': return [first(y, m - 2), last(y, m)];
      case 'last_6': return [first(y, m - 5), last(y, m)];
      case 'this_year': return [`${y}-01-01`, `${y}-12-31`];
      case 'custom': return [S.customFrom || null, S.customTo || null];
      default: return [null, null];
    }
  }
  const inPeriod = (dateISO, p) => {
    const [a, b] = periodRange(p);
    return (!a || dateISO >= a) && (!b || dateISO <= b);
  };
  const periodSelect = (id) =>
    `<select class="input" id="${id}" style="width:auto">${PERIODS.map(([v, l]) => `<option value="${v}"${S.period === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
     <span class="row${S.period === 'custom' ? '' : ' hidden'}" id="${id}-range" style="gap:6px;flex-wrap:nowrap">
       <input class="input" type="date" id="${id}-from" value="${esc(S.customFrom || '')}" style="width:auto" aria-label="From date">
       <span class="muted">to</span>
       <input class="input" type="date" id="${id}-to" value="${esc(S.customTo || '')}" style="width:auto" aria-label="To date">
     </span>`;
  // Wire a period select (and its custom From/To pickers) to a redraw.
  function bindPeriod(el, id, onChange) {
    $(`#${id}`, el).addEventListener('change', (e) => {
      S.period = e.target.value;
      store.set('period', S.period);
      $(`#${id}-range`, el).classList.toggle('hidden', S.period !== 'custom');
      onChange();
    });
    for (const [part, key] of [['from', 'customFrom'], ['to', 'customTo']]) {
      $(`#${id}-${part}`, el).addEventListener('change', (e) => {
        S[key] = e.target.value || null;
        store.set(key, S[key]);
        onChange();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Views & navigation
  // ---------------------------------------------------------------------------
  const VIEWS = {
    dashboard: { title: 'Dashboard', icon: 'dashboard', roles: ['user', 'miduser', 'superuser'], render: renderDashboard },
    transactions: { title: 'Transactions', icon: 'list', roles: ['user', 'miduser', 'superuser'], render: renderTransactions },
    approvals: { title: 'Approvals', icon: 'approve', roles: ['user', 'miduser', 'superuser'], render: renderApprovals, badge: () => S.counts.toApprove + S.counts.toPost },
    loans: { title: 'Loans', icon: 'loan', roles: ['user', 'miduser', 'superuser'], render: renderLoans },
    budgets: { title: 'Budgets', icon: 'target', roles: ['user', 'miduser', 'superuser'], render: renderBudgets },
    documents: { title: 'Documents', icon: 'file', roles: ['user', 'miduser', 'superuser'], render: renderDocuments },
    users: { title: 'Users', icon: 'users', roles: ['admin'], render: renderUsers },
    limits: { title: 'Financial Limits', icon: 'shield', roles: ['superuser'], render: renderLimits },
    messages: { title: 'Messages', icon: 'bell', roles: ['admin', 'user', 'miduser', 'superuser'], render: renderMessages, badge: () => S.counts.unread },
    audit: { title: 'Audit Trail', icon: 'history', roles: ['admin', 'superuser'], render: renderAudit },
    settings: { title: 'Settings', icon: 'settings', roles: ['admin', 'user', 'miduser', 'superuser'], render: renderSettings },
  };
  const allowedViews = () => Object.keys(VIEWS).filter((k) => VIEWS[k].roles.includes(S.me.role));
  const defaultView = () => (S.me.role === 'admin' ? 'users' : 'dashboard');

  function currentRoute() {
    const [view, param] = location.hash.replace(/^#\/?/, '').split('/');
    return { view: allowedViews().includes(view) ? view : defaultView(), param };
  }

  function renderShell() {
    const u = S.me;
    const limitLine = u.role === 'admin' ? 'No financial authority' : `Limit ${money(u.financialLimit)}`;
    $('#root').innerHTML = `
      <div class="app">
        <aside class="sidebar">
          <div class="brand">
            <div class="brand-mark">${esc(S.company.trim().charAt(0).toUpperCase() || 'A')}</div>
            <div><div class="brand-name">${esc(S.company)}</div><div class="brand-sub">Ledger Book</div></div>
          </div>
          <nav class="nav" id="nav"></nav>
          <div class="sidebar-foot">
            <div class="nav-sep"></div>
            <div class="who"><div class="who-name">${esc(u.fullName)}</div><div class="who-role">${ROLE_LABEL[u.role]} · ${esc(limitLine)}</div></div>
            <nav class="nav">
              <a href="/help" target="_blank" rel="noopener">${icon('help')}Help</a>
              <button data-act="change-password">${icon('key')}Change password</button>
              <button data-act="logout">${icon('logout')}Sign out</button>
            </nav>
          </div>
        </aside>
        <div class="main">
          <header class="topbar">
            <div class="titles">
              <div class="company-line">${esc(S.company)}</div>
              <h1 class="page-title" id="page-title"></h1>
            </div>
            <div class="top-actions">
              ${isFinancial() ? `<button class="btn hide-mobile" data-act="print" title="Print ledger statement">${icon('print')}<span class="label-lg">Print</span></button>` : ''}
              <a class="btn icon-only" href="#/messages" title="Messages" aria-label="Messages">${icon('bell')}<span class="count hidden" id="bell-count"></span></a>
              ${isFinancial() ? `<button class="btn primary" data-act="add-entry">${icon('plus')}<span class="label-lg">Add entry</span></button>` : ''}
              ${u.role === 'admin' ? `<button class="btn primary" data-act="new-user">${icon('plus')}<span class="label-lg">New user</span></button>` : ''}
            </div>
          </header>
          <main class="content" id="content"></main>
        </div>
      </div>
      <nav class="mobile-tabs" id="mobile-tabs"></nav>`;
    document.body.addEventListener('click', onGlobalClick);
  }

  function renderNav() {
    const views = allowedViews();
    const item = (k, cls = '') => {
      const v = VIEWS[k];
      const n = v.badge ? v.badge() : 0;
      return `<a href="#/${k}" class="${cls}${S.view === k ? ' active' : ''}">${icon(v.icon)}<span>${esc(v.title)}</span>${n ? `<span class="badge">${n}</span>` : ''}</a>`;
    };
    $('#nav').innerHTML = views.map((k) => item(k)).join('');
    $('#mobile-tabs').innerHTML = views.map((k) => item(k)).join('');
    const bell = $('#bell-count');
    bell.textContent = S.counts.unread;
    bell.classList.toggle('hidden', !S.counts.unread);
    document.title = `${VIEWS[S.view]?.title || 'Ledger Book'} — ${S.company}`;
  }

  async function route() {
    const { view, param } = currentRoute();
    S.view = view;
    $('#page-title').textContent = VIEWS[view].title;
    renderNav();
    try {
      await VIEWS[view].render($('#content'), param);
    } catch (err) {
      $('#content').innerHTML = `<div class="alert danger">${icon('alert')}${esc(err.message)}</div>`;
    }
  }

  const rerender = () => route();

  async function onGlobalClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'logout') {
      await pushForgetDevice().catch(() => {});
      await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
      location.href = '/login';
    } else if (act === 'change-password') openChangePassword(false);
    else if (act === 'add-entry') openAddEntry();
    else if (act === 'print') openStatementDialog();
    else if (act === 'new-user') openUserEditor(null);
    else if (act === 'open-tx') openTxDetail(el.dataset.id);
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------
  async function loadMe() {
    const r = await api('/api/me');
    S.me = r.user;
    S.company = r.company;
    S.currency = r.currency || S.currency;
    S.pushKey = r.pushKey || null;
    S.version = r.version || '';
    const prevUnread = S.counts.unread;
    S.counts = { unread: r.unread, toApprove: r.toApprove, toPost: r.toPost };
    return { prevUnread };
  }
  async function loadState() {
    if (!isFinancial() || S.me.mustChangePassword) return;
    S.data = await api('/api/state');
    S.currency = S.data.settings.currency || S.currency;
  }
  async function refreshAll() {
    await loadMe();
    await loadState();
    S.notifications = null;
    S.audit = null;
    S.limitHistory = null;
    if (S.me.role !== 'user') S.users = null;
    await rerender();
  }

  let polling = null;
  function startPolling() {
    clearInterval(polling);
    polling = setInterval(async () => {
      if (document.hidden) return;
      try {
        const before = { ...S.counts };
        await loadMe();
        const changed = before.toApprove !== S.counts.toApprove || before.toPost !== S.counts.toPost || before.unread !== S.counts.unread;
        if (S.counts.unread > before.unread) {
          const r = await api('/api/notifications');
          S.notifications = r.notifications;
          const newest = r.notifications.find((n) => !n.read);
          if (newest) toast(`New message: ${newest.title}`);
        }
        if (changed) {
          await loadState();
          if (!$('.modal-back')) await rerender();
          else renderNav();
        }
      } catch {
        /* offline — try again next tick */
      }
    }, 30000);
  }

  // ---------------------------------------------------------------------------
  // Modal
  // ---------------------------------------------------------------------------
  function openModal({ title, body, footer = '', wide = false, dismissable = true, onClose }) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal-h"><div><div class="company-line">${esc(S.company)}</div><h3>${esc(title)}</h3></div>
          ${dismissable ? `<button class="modal-x" data-close aria-label="Close">${icon('x')}</button>` : ''}</div>
        <div class="modal-b">${body}</div>
        ${footer ? `<div class="modal-f">${footer}</div>` : ''}
      </div>`;
    const close = () => {
      back.remove();
      document.removeEventListener('keydown', onKey);
      onClose && onClose();
    };
    const onKey = (e) => e.key === 'Escape' && dismissable && close();
    document.addEventListener('keydown', onKey);
    back.addEventListener('mousedown', (e) => e.target === back && dismissable && close());
    back.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    document.body.appendChild(back);
    const first = back.querySelector('input:not([type=hidden]):not([type=file]), select, textarea');
    if (first) setTimeout(() => first.focus(), 30);
    return { el: back, close };
  }

  function confirmModal({ title, message, confirmLabel = 'Confirm', danger = false, remark = null, typed = null }) {
    return new Promise((resolve) => {
      let done = false;
      const m = openModal({
        title,
        body: `<div>${message}</div>
          ${remark ? `<label class="field"><span>${esc(remark.label)}${remark.required ? ' *' : ''}</span><textarea class="input" id="cm-remark" maxlength="500" placeholder="${esc(remark.placeholder || '')}"></textarea></label>` : ''}
          ${typed ? `<label class="field"><span>Type <b>${esc(typed)}</b> to confirm</span><input class="input" id="cm-typed" autocomplete="off"></label>` : ''}
          <div class="small" id="cm-err" style="color:var(--danger)"></div>`,
        footer: `<button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cm-ok">${esc(confirmLabel)}</button>`,
        onClose: () => !done && resolve(null),
      });
      $('#cm-ok', m.el).addEventListener('click', () => {
        const r = remark ? $('#cm-remark', m.el).value.trim() : '';
        if (remark?.required && !r) return ($('#cm-err', m.el).textContent = 'This field is required.');
        if (typed && $('#cm-typed', m.el).value.trim() !== typed) return ($('#cm-err', m.el).textContent = `Type ${typed} exactly.`);
        done = true;
        m.close();
        resolve({ remark: r });
      });
    });
  }

  async function withBusy(btn, fn) {
    const label = btn.innerHTML;
    btn.disabled = true;
    try {
      return await fn();
    } catch (err) {
      toast(err.message, 'error');
      return undefined;
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }

  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------
  function postedTx() {
    return (S.data?.transactions || []).filter((t) => t.status === 'posted');
  }

  function renderDashboard(el) {
    const d = S.data;
    const posted = postedTx().filter((t) => inPeriod(t.dateISO, S.period));
    const received = posted.filter((t) => t.type === 'receive').reduce((a, t) => a + t.amount, 0);
    const spent = posted.filter((t) => t.type === 'expense').reduce((a, t) => a + t.amount, 0);
    const net = received - spent;
    const needsReview = posted.filter((t) => t.category === 'Needs review' && t.type !== 'transfer').length;
    const recent = postedTx().slice(0, 8);
    // The user's own entries still going through approval stay visible here
    // until they are posted (or rejected / withdrawn).
    const myPending = d.transactions.filter((t) => t.initiatedBy === S.me.id && (t.status === 'pending_approval' || t.status === 'approved'));
    const alerts = [];
    if (S.counts.toApprove)
      alerts.push(`<div class="alert caution">${icon('clock')}<span><b>${S.counts.toApprove}</b> transaction${S.counts.toApprove > 1 ? 's await' : ' awaits'} your approval.</span><a class="btn sm" href="#/approvals/approve">Review now</a></div>`);
    if (S.pushKey && pushSupported() && Notification.permission === 'default' && !store.get('pushNudgeHidden', false))
      alerts.push(`<div class="alert info" id="push-nudge">${icon('bell')}<span>Get a phone alert when your approval is needed.</span><a class="btn sm primary" href="#/settings">Turn on</a><button class="btn sm" id="push-nudge-x">Not now</button></div>`);
    if (S.counts.toPost)
      alerts.push(`<div class="alert info">${icon('send')}<span><b>${S.counts.toPost}</b> approved transaction${S.counts.toPost > 1 ? 's are' : ' is'} back with you for final posting.</span><a class="btn sm" href="#/approvals/post">Post now</a></div>`);

    el.innerHTML = `
      <div class="stack">
        <div class="row"><span class="muted">Showing</span>${periodSelect('dash-period')}<span class="spacer"></span>
          <span class="small muted">Only posted transactions are counted.</span></div>
        ${alerts.join('')}
        ${
          myPending.length
            ? `<div class="card">
          <div class="card-h"><h3>My transactions awaiting approval</h3><span class="badge soft">${myPending.length}</span><span class="spacer"></span><a class="btn sm" href="#/approvals/mine">Track all</a></div>
          <div class="card-b" style="padding-top:6px">${txTable(myPending, { compact: true, showStatus: true })}
            <div class="small muted" style="margin-top:8px">These are not in the ledger yet. They are counted once approved and finally posted.</div></div>
        </div>`
            : ''
        }
        <div class="cards">
          <div class="card stat"><div class="label"><span class="dot" style="background:var(--positive)"></span>Funds received</div><div class="value pos">${money(received)}</div><div class="foot">${posted.filter((t) => t.type === 'receive').length} Receive Fund entries</div></div>
          <div class="card stat"><div class="label"><span class="dot" style="background:var(--caution)"></span>Expenses</div><div class="value">${money(spent)}</div><div class="foot">${posted.filter((t) => t.type === 'expense').length} expense entries</div></div>
          <div class="card stat"><div class="label">Net</div><div class="value ${net >= 0 ? 'pos' : ''}">${money(net, { sign: true })}</div><div class="foot">Received − expenses</div></div>
          <div class="card stat navy"><div class="label">${icon('wallet')}Petty Cash</div><div class="value">${money(d.pettyCash)}</div><div class="foot"><a href="#" id="fund-pc">Fund Petty Cash →</a></div></div>
          ${d.loans.length ? `<div class="card stat"><div class="label">${icon('loan')}Loans outstanding</div><div class="value">${money(d.loans.reduce((a, l) => a + l.outstanding, 0))}</div><div class="foot"><a href="#/loans">${d.loans.filter((l) => l.status === 'active').length} active loan${d.loans.filter((l) => l.status === 'active').length === 1 ? '' : 's'} →</a></div></div>` : ''}
          <div class="card stat"><div class="label">${icon('shield')}My financial limit</div><div class="value">${money(S.me.financialLimit)}</div><div class="foot">${S.me.financialLimit > 0 ? 'Entries up to this post immediately' : 'Not assigned — all entries need approval'}</div></div>
        </div>
        <div class="split">
          <div class="card">
            <div class="card-h"><h3>Cash flow</h3>
              <div class="legend"><span><span class="dot" style="background:var(--series-1)"></span>Received</span><span><span class="dot" style="background:var(--series-2)"></span>Expenses</span></div></div>
            <div class="card-b">${cashFlowChart(posted)}</div>
          </div>
          <div class="card">
            <div class="card-h"><h3>Expenses by category</h3></div>
            <div class="card-b">${categoryBars(posted)}</div>
          </div>
        </div>
        <div class="split">
          <div class="card">
            <div class="card-h"><h3>Recent posted activity</h3><span class="spacer"></span><a class="btn sm" href="#/transactions">View all</a></div>
            <div class="card-b" style="padding-top:6px">${recent.length ? txTable(recent, { compact: true }) : emptyState('list', 'No posted transactions yet. Use “Add entry” to record the first one.')}</div>
          </div>
          <div class="stack">
            <div class="card">
              <div class="card-h"><h3>Account balances</h3></div>
              <div class="card-b">${accountBalanceList()}</div>
            </div>
            <div class="card"><div class="card-b">
              <div class="row">${icon('info')}<b>Ledger insight</b></div>
              <div class="small" style="margin-top:6px;color:var(--ink-2)">${needsReview ? `${needsReview} posted entr${needsReview > 1 ? 'ies are' : 'y is'} still in “Needs review” for this period — assign a category for accurate reporting.` : 'Every posted entry in this period has a category.'}</div>
            </div></div>
          </div>
        </div>
      </div>`;
    bindPeriod(el, 'dash-period', rerender);
    $('#push-nudge-x', el)?.addEventListener('click', () => {
      store.set('pushNudgeHidden', true);
      $('#push-nudge', el).remove();
    });
    $('#fund-pc', el).addEventListener('click', (e) => {
      e.preventDefault();
      openAddEntry({ type: 'transfer', toAccount: PETTY_CASH });
    });
    bindChartHover(el);
  }

  function accountBalanceList() {
    const accounts = S.data.settings.accounts;
    return accounts
      .map((a) => {
        const b = S.data.balances[a] || 0;
        return `<div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)"><span>${esc(a)}${a === PETTY_CASH ? ' <span class="chip neutral">System</span>' : ''}</span><b class="num">${money(b)}</b></div>`;
      })
      .join('') +
      (S.data.loans.length
        ? `<div class="row" style="justify-content:space-between;padding:6px 0"><a href="#/loans">${esc(S.data.loanAccount)}</a><b class="num">${money(S.data.balances[S.data.loanAccount] || 0)}</b></div>
           <div class="small muted">Money lent to persons and not yet recovered. Not counted as an expense.</div>`
        : '');
  }

  function emptyState(ic, text) {
    return `<div class="empty">${icon(ic)}<div>${esc(text)}</div></div>`;
  }

  function cashFlowChart(posted) {
    // Monthly buckets across the posted data in the selected period (max 12 latest).
    const months = new Map();
    for (const t of posted) {
      if (t.type === 'transfer') continue;
      const k = t.dateISO.slice(0, 7);
      const m = months.get(k) || { r: 0, e: 0 };
      if (t.type === 'receive') m.r += t.amount;
      else m.e += t.amount;
      months.set(k, m);
    }
    const keys = [...months.keys()].sort().slice(-12);
    if (!keys.length) return emptyState('dashboard', 'No posted receipts or expenses in this period.');
    const W = 640, H = 230, L = 46, B = 26, T = 10;
    const max = Math.max(...keys.map((k) => Math.max(months.get(k).r, months.get(k).e)), 1);
    const nice = niceMax(max);
    const band = (W - L) / keys.length;
    const bw = Math.max(4, Math.min(26, band / 3.2));
    const y = (v) => T + (H - T - B) * (1 - v / nice);
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const v = (nice / 4) * i;
      grid += `<line x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`;
    }
    const barPath = (x, v, color) => {
      const top = y(v), base = y(0), h = base - top;
      if (h <= 0.5) return '';
      const r = Math.min(4, h, bw / 2);
      return `<path fill="${color}" d="M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${base} Z"/>`;
    };
    let bars = '';
    keys.forEach((k, i) => {
      const m = months.get(k);
      const cx = L + band * i + band / 2;
      const [yy, mm] = k.split('-');
      bars += barPath(cx - bw - 1, m.r, 'var(--series-1)') + barPath(cx + 1, m.e, 'var(--series-2)');
      bars += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${MON[+mm - 1]}${keys.length <= 6 || +mm === 1 ? ` ${yy.slice(2)}` : ''}</text>`;
      bars += `<rect class="bar-hit" x="${L + band * i}" y="${T}" width="${band}" height="${H - T - B}" data-tip="${esc(`${MON[+mm - 1]} ${yy}|Received ${money(m.r)}|Expenses ${money(m.e)}`)}"/>`;
    });
    return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly funds received and expenses"><g class="grid">${grid}</g>${bars}</svg></div>`;
  }
  function niceMax(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  function bindChartHover(el) {
    $$('.chart', el).forEach((chart) => {
      let tip = null;
      chart.addEventListener('mousemove', (e) => {
        const hit = e.target.closest('[data-tip]');
        if (!hit) return tip && (tip.remove(), (tip = null));
        if (!tip) {
          tip = document.createElement('div');
          tip.className = 'tooltip';
          chart.appendChild(tip);
        }
        const [head, ...lines] = hit.dataset.tip.split('|');
        tip.innerHTML = `<b>${esc(head)}</b><br>${lines.map(esc).join('<br>')}`;
        const r = chart.getBoundingClientRect();
        const hr = hit.getBoundingClientRect();
        tip.style.left = `${Math.min(Math.max(hr.left + hr.width / 2 - r.left, 80), r.width - 80)}px`;
        tip.style.top = `${e.clientY - r.top}px`;
      });
      chart.addEventListener('mouseleave', () => tip && (tip.remove(), (tip = null)));
    });
  }

  function categoryBars(posted) {
    const by = new Map();
    for (const t of posted) if (t.type === 'expense') by.set(t.category, (by.get(t.category) || 0) + t.amount);
    let rows = [...by.entries()].sort((a, b) => b[1] - a[1]);
    if (!rows.length) return emptyState('target', 'No posted expenses in this period.');
    if (rows.length > 8) {
      const other = rows.slice(7).reduce((a, r) => a + r[1], 0);
      rows = [...rows.slice(0, 7), ['Other', other]];
    }
    const max = rows[0][1];
    return rows
      .map(([c, v]) => `<div class="hbar" title="${esc(c)}: ${esc(money(v))}"><span class="name">${esc(c)}</span><div class="track"><div class="fill" style="width:${Math.max(1, (v / max) * 100)}%"></div></div><b class="num small">${money(v)}</b></div>`)
      .join('');
  }

  // ---------------------------------------------------------------------------
  // Transactions
  // ---------------------------------------------------------------------------
  function signedAmount(t, account) {
    if (!account && t.kind === 'loan_given') return -t.amount;
    if (!account && t.kind === 'loan_recovery') return t.amount;
    if (t.type === 'receive') return t.amount;
    if (t.type === 'expense') return -t.amount;
    if (account && t.toAccount === account) return t.amount;
    if (account && t.account === account) return -t.amount;
    return 0;
  }
  // Where an unposted transaction stands, in words: who has it now.
  function statusNote(t) {
    const me = S.me.id;
    if (t.status === 'pending_approval')
      return t.approverId === me ? 'Waiting for your approval' : `Waiting for approval by ${userName(t.approverId)}`;
    if (t.status === 'approved')
      return t.initiatedBy === me ? 'Approved — back with you for final posting' : `Approved — awaiting final posting by ${userName(t.initiatedBy)}`;
    if (t.status === 'rejected') return `Rejected by ${userName(t.decidedBy)}`;
    return '';
  }
  const statusCell = (t) => `${statusChip(t.status)}${statusNote(t) ? `<div class="sub" style="margin-top:3px">${esc(statusNote(t))}</div>` : ''}`;

  function txTable(list, { compact: small = false, showStatus = false, footer = false, account = '' } = {}) {
    const rows = list
      .map((t) => {
        const amt = signedAmount(t, account);
        const where = t.type === 'transfer' ? `${esc(t.account)} → ${esc(t.toAccount)}` : esc(t.account);
        return `<tr class="click${t.status !== 'posted' ? ' unposted' : ''}" data-act="open-tx" data-id="${t.id}">
          <td class="${small ? 'hide-mobile' : ''}"><div class="num">${esc(t.date)}</div><div class="sub">${esc(t.voucherNo)}</div></td>
          <td><div class="desc">${esc(t.description)}</div><div class="sub">${small ? `${esc(t.date)} · ` : ''}${esc(TYPE_LABEL[t.kind || t.type])} · ${where}${t.tags.length ? ' · ' + t.tags.map(esc).join(', ') : ''}</div></td>
          ${small ? '' : `<td class="hide-mobile">${esc(t.category)}</td><td class="hide-mobile">${esc(userName(t.initiatedBy))}</td>`}
          ${showStatus ? `<td>${statusCell(t)}</td>` : ''}
          <td class="num"><b class="${t.type === 'receive' || amt > 0 ? 'pos' : ''}">${t.type === 'transfer' && !account && !isLoan(t) ? money(t.amount) : money(amt, { sign: true })}</b></td>
        </tr>`;
      })
      .join('');
    let foot = '';
    if (footer) {
      // Only posted entries are part of the ledger, so only they are totalled.
      const posted = list.filter((t) => t.status === 'posted');
      const r = posted.filter((t) => t.type === 'receive').reduce((a, t) => a + t.amount, 0);
      const e = posted.filter((t) => t.type === 'expense').reduce((a, t) => a + t.amount, 0);
      const unposted = list.length - posted.length;
      const span = (small ? 2 : 4) + (showStatus ? 1 : 0);
      foot = `<tfoot><tr><td colspan="${span}">${posted.length} posted · Received ${money(r)} · Expenses ${money(e)}${unposted ? ` <span class="muted" style="font-weight:500">· ${unposted} not yet posted (not included in totals)</span>` : ''}</td><td class="num">${money(r - e, { sign: true })}</td></tr></tfoot>`;
    }
    return `<div class="table-wrap"><table class="tbl">
      <thead><tr><th class="${small ? 'hide-mobile' : ''}">Date / Voucher</th><th>Description</th>${small ? '' : '<th class="hide-mobile">Category</th><th class="hide-mobile">Initiated by</th>'}${showStatus ? '<th>Status</th>' : ''}<th class="num">Amount</th></tr></thead>
      <tbody>${rows}</tbody>${foot}</table></div>`;
  }
  function renderTransactions(el) {
    const d = S.data;
    const f = S.txFilters;
    const opts = (arr, sel, all) => `<option value="">${all}</option>` + arr.map((v) => `<option${v === sel ? ' selected' : ''}>${esc(v)}</option>`).join('');
    el.innerHTML = `
      <div class="card">
        <div class="filters">
          <input class="input search" id="f-q" placeholder="Search description, voucher, tag…" value="${esc(f.q)}">
          <select class="input" id="f-status">
            ${[['active', 'Posted & pending'], ['posted', 'Posted only'], ['pending_approval', 'Pending approval'], ['approved', 'Awaiting final posting'], ['rejected', 'Rejected'], ['cancelled', 'Withdrawn'], ['', 'All statuses']]
              .map(([v, l]) => `<option value="${v}"${f.status === v ? ' selected' : ''}>${l}</option>`).join('')}
          </select>
          <select class="input" id="f-type">${[['', 'All types'], ['expense', 'Expense'], ['receive', 'Receive Fund'], ['transfer', 'Transfer'], ['loan_given', 'Loan given'], ['loan_recovery', 'Loan recovery']].map(([v, l]) => `<option value="${v}"${f.type === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
          <select class="input" id="f-account">${opts(d.settings.accounts, f.account, 'All accounts')}</select>
          <select class="input" id="f-category">${opts(d.settings.categories, f.category, 'All categories')}</select>
          <select class="input" id="f-tag">${opts(d.tags, f.tag, 'All tags')}</select>
          ${periodSelect('f-period')}
          <button class="btn" id="f-csv" title="Download the filtered list as CSV">${icon('csv')}CSV</button>
        </div>
        <div class="card-b" id="tx-list"></div>
      </div>`;
    const draw = () => {
      const q = f.q.toLowerCase();
      const list = d.transactions.filter(
        (t) =>
          (!f.status || (f.status === 'active' ? ACTIVE_STATUSES.includes(t.status) : t.status === f.status)) &&
          (!f.type || (t.kind || t.type) === f.type) &&
          (!f.account || t.account === f.account || t.toAccount === f.account) &&
          (!f.category || (t.category === f.category && t.type !== 'transfer')) &&
          (!f.tag || t.tags.includes(f.tag)) &&
          inPeriod(t.dateISO, S.period) &&
          (!q || `${t.description} ${t.voucherNo} ${t.tags.join(' ')} ${t.note || ''} ${t.category}`.toLowerCase().includes(q)),
      );
      $('#tx-list', el).innerHTML = list.length
        ? txTable(list, { showStatus: f.status !== 'posted', footer: true, account: f.account })
        : emptyState('list', 'No transactions match these filters.');
      return list;
    };
    let current = draw();
    const on = (id, key, evt = 'change') =>
      $(id, el).addEventListener(evt, (e) => {
        if (key === 'period') {
          S.period = e.target.value;
          store.set('period', S.period);
        } else f[key] = e.target.value;
        current = draw();
      });
    on('#f-q', 'q', 'input');
    on('#f-status', 'status');
    on('#f-type', 'type');
    on('#f-account', 'account');
    on('#f-category', 'category');
    on('#f-tag', 'tag');
    bindPeriod(el, 'f-period', () => (current = draw()));
    $('#f-csv', el).addEventListener('click', () => downloadCsv(current));
  }

  function downloadCsv(list) {
    const cols = ['Voucher', 'Date', 'Type', 'Description', 'Category', 'Account', 'To account', 'Amount', 'Status', 'Initiated by', 'Approved by', 'Tags', 'Note'];
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [cols.map(q).join(',')];
    for (const t of list) {
      lines.push(
        [t.voucherNo, t.date, TYPE_LABEL[t.kind || t.type], t.description, t.category, t.account, t.toAccount || '', t.amount.toFixed(2), STATUS_LABEL[t.status], userName(t.initiatedBy), t.decidedBy ? userName(t.decidedBy) : '', t.tags.join('; '), t.note || '']
          .map(q)
          .join(','),
      );
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `alidada-transactions-${isoLocal(new Date())}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------------------------------------------------------------------------
  // Transaction detail & workflow actions
  // ---------------------------------------------------------------------------
  async function openTxDetail(id) {
    let r;
    try {
      r = await api(`/api/transactions/${id}/events`);
    } catch (err) {
      return toast(err.message, 'error');
    }
    const t = r.transaction;
    const me = S.me.id;
    const doc = t.documentId ? (S.data.documents || []).find((x) => x.id === t.documentId) : null;
    const canDecide = t.status === 'pending_approval' && t.approverId === me;
    const canPost = t.status === 'approved' && t.initiatedBy === me;
    const canCancel = ['pending_approval', 'approved'].includes(t.status) && t.initiatedBy === me;
    const canReroute = t.status === 'pending_approval' && t.initiatedBy === me;
    const canReverse = t.status === 'posted' && !t.reversalOf && !S.data.transactions.some((x) => x.reversalOf === t.id && !['rejected', 'cancelled'].includes(x.status));
    const canEdit = !['rejected', 'cancelled'].includes(t.status) && (t.initiatedBy === me || isSuper());
    const where = t.type === 'transfer' ? `${esc(t.account)} → ${esc(t.toAccount)}` : esc(t.account);
    const reversal = t.reversalOf ? S.data.transactions.find((x) => x.id === t.reversalOf) : null;
    const body = `
      <div class="row">${statusChip(t.status)}<span class="spacer"></span><span class="amount" style="font-family:var(--font-head);font-size:22px;font-weight:600">${money(t.amount)}</span></div>
      ${canDecide ? `<div class="alert caution">${icon('clock')}<span>This transaction exceeds the initiator's limit and is assigned to <b>you</b> for approval.</span></div>` : ''}
      ${canPost ? `<div class="alert info">${icon('send')}<span>Approved by ${esc(userName(t.decidedBy))}. It is back with you for <b>final posting</b>.</span></div>` : ''}
      ${t.status === 'rejected' ? `<div class="alert danger">${icon('reject')}<span>Rejected by ${esc(userName(t.decidedBy))}: “${esc(t.decisionRemark || '')}”</span></div>` : ''}
      <dl class="kv">
        <dt>Voucher no.</dt><dd>${esc(t.voucherNo)}</dd>
        <dt>Date</dt><dd>${esc(t.date)}</dd>
        <dt>Type</dt><dd>${esc(TYPE_LABEL[t.kind || t.type])}</dd>
        <dt>Description</dt><dd>${esc(t.description)}</dd>
        <dt>Category</dt><dd>${esc(t.category)}</dd>
        <dt>Account</dt><dd>${where}</dd>
        <dt>Tags</dt><dd>${t.tags.length ? t.tags.map((x) => `<span class="tag">${esc(x)}</span>`).join('') : '—'}</dd>
        <dt>Note</dt><dd>${esc(t.note || '—')}</dd>
        <dt>Initiated by</dt><dd>${esc(userName(t.initiatedBy))} · ${esc(fmtDateTime(t.initiatedAt))}</dd>
        ${t.approverId ? `<dt>Approver</dt><dd>${esc(userName(t.approverId))}</dd>` : ''}
        ${t.postedBy ? `<dt>Posted</dt><dd>${esc(userName(t.postedBy))} · ${esc(fmtDateTime(t.postedAt))}${t.autoPosted ? ' (within own limit)' : ''}</dd>` : ''}
        ${t.loanId ? (() => { const l = S.data.loans.find((x) => x.id === t.loanId); return l ? `<dt>Loan</dt><dd><a href="#" data-loan="${l.id}">${esc(l.loanNo)} · ${esc(l.borrower)}</a> — outstanding ${esc(money(l.outstanding))}</dd>` : ''; })() : ''}
        ${reversal ? `<dt>Reverses</dt><dd><a href="#" data-act="open-tx" data-id="${reversal.id}">${esc(reversal.voucherNo)}</a></dd>` : ''}
        ${doc ? `<dt>Document</dt><dd><a href="/api/documents/${doc.id}/file" target="_blank" rel="noopener">${esc(doc.filename)}</a></dd>` : ''}
      </dl>
      <div><h4 style="font-size:13px;margin-bottom:10px">Approval trail</h4>
        <ul class="timeline">${r.events
          .map((e) => `<li><div class="t-act">${esc(EVENT_LABEL[e.action] || e.action)}</div><div class="t-meta">${esc(e.actorName || 'Unknown')} · ${esc(fmtDateTime(e.at))}</div>${e.remark ? `<div class="small">${esc(e.remark)}</div>` : ''}</li>`)
          .join('')}</ul></div>`;
    const footer = [
      canEdit ? `<button class="btn" data-x="edit">${icon('edit')}Edit details</button>` : '',
      canReverse ? `<button class="btn" data-x="reverse">${icon('undo')}Reverse</button>` : '',
      canReroute ? `<button class="btn" data-x="reroute">${icon('users')}Change approver</button>` : '',
      canCancel ? `<button class="btn ghost-danger" data-x="cancel">Withdraw</button>` : '',
      canDecide ? `<button class="btn ghost-danger" data-x="reject">${icon('reject')}Reject</button><button class="btn positive" data-x="approve">${icon('check')}Approve</button>` : '',
      canPost ? `<button class="btn primary" data-x="post">${icon('send')}Final post</button>` : '',
    ].join('');
    const m = openModal({ title: `${TYPE_LABEL[t.kind || t.type]} · ${t.voucherNo}`, body, footer: footer || '<button class="btn" data-close>Close</button>', wide: true });
    $('[data-loan]', m.el)?.addEventListener('click', (e) => {
      e.preventDefault();
      m.close();
      openLoanDetail(t.loanId);
    });
    $$('[data-x]', m.el).forEach((b) =>
      b.addEventListener('click', async () => {
        const action = b.dataset.x;
        if (action === 'edit') {
          m.close();
          return openTxEdit(t);
        }
        if (action === 'reroute') {
          m.close();
          return openReroute(t);
        }
        m.close();
        await runTxAction(t, action);
      }),
    );
  }

  async function runTxAction(t, action) {
    const desc = `<b>${esc(t.voucherNo)}</b> — ${esc(t.description)} (${esc(money(t.amount))})`;
    let payload = {};
    if (action === 'approve') {
      const c = await confirmModal({ title: 'Approve transaction', message: `Approve ${desc}? It will go back to ${esc(userName(t.initiatedBy))} for final posting.`, confirmLabel: 'Approve', remark: { label: 'Remark (optional)' } });
      if (!c) return;
      payload = { remark: c.remark };
    } else if (action === 'reject') {
      const c = await confirmModal({ title: 'Reject transaction', message: `Reject ${desc}? The initiator will be notified with your reason.`, confirmLabel: 'Reject', danger: true, remark: { label: 'Reason for rejection', required: true } });
      if (!c) return;
      payload = { remark: c.remark };
    } else if (action === 'post') {
      const c = await confirmModal({ title: 'Final posting', message: `Post ${desc} to the ledger? Posted entries are final and can only be corrected by a reversal entry.`, confirmLabel: 'Post to ledger' });
      if (!c) return;
    } else if (action === 'cancel') {
      const c = await confirmModal({ title: 'Withdraw transaction', message: `Withdraw ${desc}? It will not be posted.`, confirmLabel: 'Withdraw', danger: true, remark: { label: 'Reason (optional)' } });
      if (!c) return;
      payload = { remark: c.remark };
    } else if (action === 'reverse') {
      const c = await confirmModal({
        title: 'Reverse posted entry',
        message: `Create a reversal entry for ${desc}? The reversal is a new transaction dated today and follows the same financial-limit rules — if it exceeds your limit it will be sent for approval.`,
        confirmLabel: 'Create reversal',
        remark: { label: 'Note (optional)' },
      });
      if (!c) return;
      payload = { note: c.remark };
    }
    try {
      const r = await api(`/api/transactions/${t.id}/${action}`, { method: 'POST', body: payload });
      const msg = {
        approve: `Approved ${t.voucherNo}. ${userName(t.initiatedBy)} has been notified for final posting.`,
        reject: `Rejected ${t.voucherNo}. The initiator has been notified.`,
        post: `${t.voucherNo} posted to the ledger.`,
        cancel: `${t.voucherNo} withdrawn.`,
        reverse: r.outcome === 'posted' ? `Reversal ${r.transaction?.voucherNo} posted.` : `Reversal ${r.transaction?.voucherNo} sent to ${r.approver?.fullName} for approval.`,
      }[action];
      toast(msg);
      await refreshAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function openReroute(t) {
    let r;
    try {
      r = await api(`/api/approvers?amount=${t.amount}`);
    } catch (err) {
      return toast(err.message, 'error');
    }
    const choices = r.approvers.filter((a) => a.id !== t.approverId);
    if (!choices.length) return toast('No other user has sufficient financial authority for this amount.', 'error');
    const m = openModal({
      title: `Change approver · ${t.voucherNo}`,
      body: `<div>Currently assigned to <b>${esc(userName(t.approverId))}</b>. Choose another approver whose limit covers ${esc(money(t.amount))}.</div>
        <label class="field"><span>New approver</span><select class="input" id="rr-sel">${choices.map((a) => `<option value="${a.id}">${esc(a.fullName)} — ${ROLE_LABEL[a.role]}, limit ${esc(money(a.financialLimit))}</option>`).join('')}</select></label>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="rr-ok">${icon('send')}Re-route</button>`,
    });
    $('#rr-ok', m.el).addEventListener('click', (e) =>
      withBusy(e.currentTarget, async () => {
        await api(`/api/transactions/${t.id}/reroute`, { method: 'POST', body: { approverId: $('#rr-sel', m.el).value } });
        m.close();
        toast(`${t.voucherNo} re-routed. The new approver has been notified.`);
        await refreshAll();
      }),
    );
  }

  function openTxEdit(t) {
    const cats = S.data.settings.categories;
    const m = openModal({
      title: `Edit details · ${t.voucherNo}`,
      body: `<div class="small muted">Amount, date, accounts and type are locked once entered. To change them, withdraw (if unposted) or reverse (if posted) and enter it again.</div>
        ${t.type !== 'transfer' ? `<label class="field"><span>Category</span><select class="input" id="ed-cat">${cats.map((c) => `<option${c === t.category ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>` : ''}
        <label class="field"><span>Tags (comma separated)</span><input class="input" id="ed-tags" value="${esc(t.tags.join(', '))}" list="tag-list"></label>
        <datalist id="tag-list">${S.data.tags.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
        <label class="field"><span>Note</span><textarea class="input" id="ed-note" maxlength="500">${esc(t.note || '')}</textarea></label>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="ed-ok">Save</button>`,
    });
    $('#ed-ok', m.el).addEventListener('click', (e) =>
      withBusy(e.currentTarget, async () => {
        const body = { tags: $('#ed-tags', m.el).value.split(',').map((s) => s.trim()).filter(Boolean), note: $('#ed-note', m.el).value };
        if ($('#ed-cat', m.el)) body.category = $('#ed-cat', m.el).value;
        await api(`/api/transactions/${t.id}`, { method: 'PATCH', body });
        m.close();
        toast('Details saved.');
        await refreshAll();
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Add entry
  // ---------------------------------------------------------------------------
  function openAddEntry(preset = {}) {
    const st = S.data.settings;
    const f = {
      type: preset.type || 'expense',
      force: false,
      documentId: null,
      tags: [],
    };
    const accountsFrom = st.accounts;
    // Loans to persons use the same form in "loan mode": pay a loan out, or
    // record money received back against an existing loan.
    const loanMode = f.type === 'loan_given' || f.type === 'loan_recovery';
    const fixedLoan = preset.loanId ? S.data.loans.find((l) => l.id === preset.loanId) : null;
    const m = openModal({
      title: loanMode ? 'Loan to a person' : 'Add entry',
      wide: true,
      body: `
        <div class="segmented full" id="ae-type">
          ${
            loanMode
              ? `<button data-t="loan_given">${icon('down')}Give loan</button>
          <button data-t="loan_recovery">${icon('up')}Loan recovery</button>`
              : `<button data-t="expense">${icon('down')}Expense</button>
          <button data-t="receive">${icon('up')}Receive Fund</button>
          <button data-t="transfer">${icon('transfer')}Transfer</button>`
          }
        </div>
        <div id="ae-loan"></div>
        <div class="grid-2">
          <label class="field"><span>Amount (${esc(S.currency)}) *</span><input class="input num" id="ae-amount" inputmode="decimal" placeholder="0.00" autocomplete="off"></label>
          <label class="field"><span>Date (DD/MM/YYYY) *</span><input class="input num" id="ae-date" inputmode="numeric" value="${todayDMY()}" maxlength="10" autocomplete="off"></label>
        </div>
        <label class="field"><span id="ae-desc-label">Description *</span><input class="input" id="ae-desc" maxlength="200" placeholder="e.g. Office rent for September, payment from customer…"></label>
        <div class="grid-2">
          <label class="field" id="ae-cat-wrap"><span>Category</span><select class="input" id="ae-cat">${st.categories.map((c) => `<option${c === 'Needs review' ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
          <label class="field"><span id="ae-acc-label">Account</span><select class="input" id="ae-acc">${accountsFrom.map((a) => `<option>${esc(a)}</option>`).join('')}</select></label>
          <label class="field hidden" id="ae-to-wrap"><span>To account</span><select class="input" id="ae-to">${st.accounts.map((a) => `<option${a === preset.toAccount ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
        </div>
        <label class="field"><span>Tags</span>
          <div class="row" id="ae-tag-chips"></div>
          <input class="input" id="ae-tag" list="ae-tag-list" placeholder="${canManageLists() ? 'Type a tag and press Enter' : 'Choose an existing tag'}">
          <datalist id="ae-tag-list">${S.data.tags.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
        </label>
        <label class="field"><span>Note</span><textarea class="input" id="ae-note" maxlength="500" placeholder="Optional reference, cheque no., invoice no.…"></textarea></label>
        ${S.data.documentsEnabled ? `<label class="field"><span>Attach voucher / receipt (optional, max 20 MB)</span><input class="input" type="file" id="ae-file" style="padding-top:8px"></label>` : ''}
        <div id="ae-authority"></div>
        <div id="ae-warn"></div>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="ae-save">Save entry</button>`,
    });
    const el = m.el;
    const activeLoans = () => S.data.loans.filter((l) => l.outstanding > 0);
    const drawLoanFields = (t) => {
      const box = $('#ae-loan', el);
      if (t === 'loan_given' && fixedLoan) {
        box.innerHTML = `<div class="alert info">${icon('loan')}<span>Further payment on <b>${esc(fixedLoan.loanNo)}</b> to <b>${esc(fixedLoan.borrower)}</b>. Outstanding now ${esc(money(fixedLoan.outstanding))}.</span></div>`;
      } else if (t === 'loan_given') {
        box.innerHTML = `<div class="grid-2">
            <label class="field"><span>Borrower (person) *</span><input class="input" id="ae-borrower" maxlength="120" placeholder="Full name of the person" autocomplete="off"></label>
            <label class="field"><span>Borrower mobile</span><input class="input" id="ae-bmobile" inputmode="tel" maxlength="20" placeholder="01XXXXXXXXX (optional)" autocomplete="off"></label>
          </div>`;
      } else if (t === 'loan_recovery') {
        const list = activeLoans();
        const sel = preset.loanId || list[0]?.id;
        box.innerHTML = list.length
          ? `<label class="field"><span>Loan *</span><select class="input" id="ae-loanid">${list.map((l) => `<option value="${l.id}"${l.id === sel ? ' selected' : ''}>${esc(l.loanNo)} · ${esc(l.borrower)} — outstanding ${esc(money(l.outstanding))}</option>`).join('')}</select></label>
             <div class="small muted" id="ae-loan-hint" style="margin:-4px 0 6px"></div>`
          : `<div class="alert caution">${icon('alert')}<span>There is no loan with an outstanding amount to recover.</span></div>`;
        const hint = () => {
          const l = S.data.loans.find((x) => x.id === $('#ae-loanid', el)?.value);
          if (!l) return;
          const avail = l.outstanding - l.pendingRecovery;
          $('#ae-loan-hint', el).innerHTML = `Recover in full or in part, up to ${esc(money(avail))}${l.pendingRecovery > 0 ? ` (${esc(money(l.pendingRecovery))} already entered, awaiting posting)` : ''}. <a href="#" id="ae-full">Recover in full</a>`;
          $('#ae-full', el).addEventListener('click', (e) => {
            e.preventDefault();
            $('#ae-amount', el).value = avail.toFixed(2);
            checkAuthority();
          });
        };
        $('#ae-loanid', el)?.addEventListener('change', () => (hint(), resetForce()));
        hint();
      } else box.innerHTML = '';
    };
    const setType = (t) => {
      f.type = t;
      const loan = t === 'loan_given' || t === 'loan_recovery';
      $$('#ae-type button', el).forEach((b) => b.classList.toggle('on', b.dataset.t === t));
      $('#ae-cat-wrap', el).classList.toggle('hidden', t === 'transfer' || loan);
      $('#ae-to-wrap', el).classList.toggle('hidden', t !== 'transfer');
      $('#ae-acc-label', el).textContent = t === 'transfer' ? 'From account' : t === 'receive' || t === 'loan_recovery' ? 'Received into account' : 'Paid from account';
      $('#ae-desc-label', el).textContent = loan ? 'Purpose / remark (optional)' : 'Description *';
      $('#ae-desc', el).placeholder = t === 'loan_given' ? 'e.g. Medical advance, to be repaid by December' : t === 'loan_recovery' ? 'e.g. First instalment, cash' : 'e.g. Office rent for September, payment from customer…';
      drawLoanFields(t);
      resetForce();
    };
    $$('#ae-type button', el).forEach((b) => b.addEventListener('click', () => setType(b.dataset.t)));
    if (preset.type === 'transfer' && preset.toAccount) {
      const firstOther = accountsFrom.find((a) => a !== preset.toAccount);
      if (firstOther) $('#ae-acc', el).value = firstOther;
    }
    setType(f.type);
    if ($('#ae-borrower', el)) setTimeout(() => $('#ae-borrower', el).focus(), 40);

    // Masked DD/MM/YYYY date input
    $('#ae-date', el).addEventListener('input', (e) => {
      const digits = e.target.value.replace(/\D/g, '').slice(0, 8);
      let out = digits.slice(0, 2);
      if (digits.length > 2) out += '/' + digits.slice(2, 4);
      if (digits.length > 4) out += '/' + digits.slice(4);
      e.target.value = out;
      resetForce();
    });

    // Tags
    const drawTags = () => {
      $('#ae-tag-chips', el).innerHTML = f.tags.map((t, i) => `<span class="tag">${esc(t)}<button type="button" data-i="${i}" aria-label="Remove">×</button></span>`).join('');
      $$('#ae-tag-chips button', el).forEach((b) => b.addEventListener('click', () => (f.tags.splice(+b.dataset.i, 1), drawTags())));
    };
    const addTag = (v) => {
      if (!v || f.tags.includes(v)) return true;
      if (!canManageLists() && !S.data.tags.includes(v)) {
        toast(`Tag “${v}” does not exist. Choose an existing tag — only Mid Users and Super Users can create new tags.`, 'error');
        return false;
      }
      f.tags.push(v);
      return true;
    };
    $('#ae-tag', el).addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        if (addTag(e.target.value.trim())) e.target.value = '';
        drawTags();
      }
    });
    // Picking a suggestion from the list adds it straight away.
    $('#ae-tag', el).addEventListener('change', (e) => {
      const v = e.target.value.trim();
      if (S.data.tags.includes(v) && addTag(v)) {
        e.target.value = '';
        drawTags();
      }
    });

    // Live authority check: does this post immediately or go for approval?
    let authTimer = null;
    let lastAuth = null;
    const checkAuthority = () => {
      clearTimeout(authTimer);
      const amount = Number($('#ae-amount', el).value.replace(/[,\s]/g, ''));
      const box = $('#ae-authority', el);
      if (!(amount > 0)) {
        box.innerHTML = '';
        lastAuth = null;
        return;
      }
      authTimer = setTimeout(async () => {
        try {
          const r = await api(`/api/approvers?amount=${amount}`);
          lastAuth = r;
          if (r.withinLimit) {
            box.innerHTML = `<div class="authority ok">${icon('check')}<div><b>Within your financial limit</b> of ${esc(money(S.me.financialLimit))}. This entry will be <b>posted immediately</b>.</div></div>`;
          } else if (r.approvers.length) {
            box.innerHTML = `<div class="authority route">${icon('send')}<div style="flex:1"><b>Exceeds your financial limit</b> of ${esc(money(S.me.financialLimit))}. It will be sent for approval and come back to you for final posting.
              <select class="input" id="ae-approver">${r.approvers.map((a) => `<option value="${a.id}">Approver: ${esc(a.fullName)} — ${ROLE_LABEL[a.role]}, limit ${esc(money(a.financialLimit))}</option>`).join('')}</select></div></div>`;
          } else {
            box.innerHTML = `<div class="authority none">${icon('alert')}<div><b>No approver available.</b> This amount exceeds your limit, and no other user has a financial limit of ${esc(money(amount))} or more. Ask a Super User to assign a sufficient limit.</div></div>`;
          }
        } catch {
          box.innerHTML = '';
        }
      }, 250);
    };
    $('#ae-amount', el).addEventListener('input', () => {
      checkAuthority();
      resetForce();
    });
    ['#ae-desc', '#ae-acc', '#ae-to', '#ae-cat'].forEach((s) => $(s, el).addEventListener('input', resetForce));
    if (preset.amount) {
      $('#ae-amount', el).value = preset.amount;
      checkAuthority();
    }

    function resetForce() {
      if (!f.force) return;
      f.force = false;
      $('#ae-warn', el).innerHTML = '';
      $('#ae-save', el).textContent = 'Save entry';
    }

    $('#ae-save', el).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const fileInput = $('#ae-file', el);
        if (fileInput && fileInput.files[0] && !f.documentId) {
          const fd = new FormData();
          fd.append('file', fileInput.files[0]);
          const up = await api('/api/documents', { method: 'POST', body: fd, raw: true });
          f.documentId = up.document.id;
        }
        const pending = $('#ae-tag', el).value.trim();
        if (pending && !addTag(pending)) return;
        if (f.type === 'loan_recovery' && !$('#ae-loanid', el)) throw new Error('There is no loan to recover.');
        $('#ae-tag', el).value = '';
        const body = {
          type: f.type,
          amount: $('#ae-amount', el).value,
          date: $('#ae-date', el).value,
          description: $('#ae-desc', el).value,
          category: f.type === 'transfer' ? undefined : $('#ae-cat', el).value,
          account: $('#ae-acc', el).value,
          toAccount: f.type === 'transfer' ? $('#ae-to', el).value : undefined,
          loanId: f.type === 'loan_recovery' ? $('#ae-loanid', el)?.value : f.type === 'loan_given' && fixedLoan ? fixedLoan.id : undefined,
          borrower: $('#ae-borrower', el)?.value,
          borrowerMobile: $('#ae-bmobile', el)?.value,
          tags: f.tags,
          note: $('#ae-note', el).value,
          documentId: f.documentId,
          approverId: $('#ae-approver', el)?.value,
          force: f.force,
        };
        const r = await api('/api/transactions', { method: 'POST', body });
        m.close();
        toast(r.outcome === 'posted' ? `${r.transaction.voucherNo} posted to the ledger.` : `${r.transaction.voucherNo} sent to ${r.approver.fullName} for approval. You'll get a message when it comes back for final posting.`);
        await refreshAll();
      } catch (err) {
        const d = err.data || {};
        if (d.reason === 'duplicate') {
          const x = d.existing;
          f.force = true;
          $('#ae-warn', el).innerHTML = `<div class="dup">${icon('alert')} <b>Possible duplicate.</b> This matches <b>${esc(x.voucherNo)}</b> — ${esc(x.description)}, ${esc(money(x.amount))} on ${esc(x.date)} (${esc(STATUS_LABEL[x.status])}). Click <b>Add anyway</b> if this is a genuine second entry.</div>`;
          btn.textContent = 'Add anyway';
        } else {
          $('#ae-warn', el).innerHTML = `<div class="alert danger">${icon('alert')}<span>${esc(err.message)}</span></div>`;
        }
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Loans to persons
  // ---------------------------------------------------------------------------
  const LOAN_STATUS = {
    active: ['Outstanding', 'pending_approval'],
    closed: ['Fully recovered', 'posted'],
    awaiting: ['Payment awaiting approval', 'approved'],
    void: ['Cancelled', 'cancelled'],
  };
  const loanChip = (l) => `<span class="chip ${LOAN_STATUS[l.status][1]}">${esc(LOAN_STATUS[l.status][0])}</span>`;
  const dmyISO = (iso) => (iso ? iso.split('-').reverse().join('-') : '—');

  function renderLoans(el, param) {
    const loans = S.data.loans;
    const f = (S.loanFilter ||= { q: '', status: 'active' });
    const sum = (k, list = loans) => list.reduce((a, l) => a + l[k], 0);
    const active = loans.filter((l) => l.status === 'active');
    el.innerHTML = `
      <div class="stack">
        <div class="row"><span class="muted">Money paid to a person and recovered later, in full or in parts. Loans are not expenses or funds received: they stay in the <b>${esc(S.data.loanAccount)}</b> account until recovered.</span><span class="spacer"></span>
          <button class="btn primary" id="ln-new">${icon('plus')}Give a loan</button>
          ${active.length ? `<button class="btn" id="ln-rec">${icon('up')}Record recovery</button>` : ''}</div>
        <div class="cards">
          <div class="card stat navy"><div class="label">${icon('loan')}Outstanding</div><div class="value">${money(sum('outstanding'))}</div><div class="foot">${active.length} active loan${active.length === 1 ? '' : 's'}</div></div>
          <div class="card stat"><div class="label"><span class="dot" style="background:var(--caution)"></span>Total paid out</div><div class="value">${money(sum('given'))}</div><div class="foot">Posted loan payments</div></div>
          <div class="card stat"><div class="label"><span class="dot" style="background:var(--positive)"></span>Total recovered</div><div class="value pos">${money(sum('recovered'))}</div><div class="foot">Posted recoveries</div></div>
        </div>
        <div class="card">
          <div class="filters">
            <input class="input search" id="ln-q" placeholder="Search borrower, loan no., mobile…" value="${esc(f.q)}">
            <select class="input" id="ln-status">${[['active', 'Outstanding'], ['closed', 'Fully recovered'], ['awaiting', 'Awaiting approval'], ['', 'All loans']].map(([v, l]) => `<option value="${v}"${f.status === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
          </div>
          <div class="card-b" id="ln-list"></div>
        </div>
      </div>`;
    const draw = () => {
      const q = f.q.toLowerCase();
      const list = loans.filter((l) => (!f.status || l.status === f.status) && (!q || `${l.loanNo} ${l.borrower} ${l.mobile || ''} ${l.purpose || ''}`.toLowerCase().includes(q)));
      $('#ln-list', el).innerHTML = list.length
        ? `<div class="table-wrap"><table class="tbl">
            <thead><tr><th class="hide-mobile">Loan</th><th>Borrower</th><th class="hide-mobile">Last activity</th><th class="num hide-mobile">Paid out</th><th class="num hide-mobile">Recovered</th><th class="num">Outstanding</th><th class="hide-mobile">Status</th></tr></thead>
            <tbody>${list
              .map(
                (l) => `<tr class="click" data-loan="${l.id}">
                <td class="hide-mobile"><div class="num">${esc(l.loanNo)}</div><div class="sub">since ${esc(dmyISO(l.firstDate))}</div></td>
                <td><div class="desc">${esc(l.borrower)}</div><div class="sub">${esc(l.mobile || '')}${l.purpose ? `${l.mobile ? ' · ' : ''}${esc(l.purpose)}` : ''}</div>
                  <div class="sub show-mobile">${esc(l.loanNo)} · ${esc(LOAN_STATUS[l.status][0])}</div></td>
                <td class="hide-mobile">${esc(dmyISO(l.lastDate))}</td>
                <td class="num hide-mobile">${money(l.given)}</td>
                <td class="num hide-mobile pos">${money(l.recovered)}</td>
                <td class="num"><b>${money(l.outstanding)}</b>${l.pendingGiven || l.pendingRecovery ? `<div class="sub">${l.pendingGiven ? `+${esc(money(l.pendingGiven))} awaiting` : ''}${l.pendingRecovery ? ` −${esc(money(l.pendingRecovery))} awaiting` : ''}</div>` : ''}</td>
                <td class="hide-mobile">${loanChip(l)}</td></tr>`,
              )
              .join('')}</tbody>
            <tfoot><tr><td class="hide-mobile" colspan="3">${list.length} loan${list.length === 1 ? '' : 's'}</td><td class="show-mobile">${list.length} loan${list.length === 1 ? '' : 's'}</td><td class="num hide-mobile">${money(sum('given', list))}</td><td class="num hide-mobile">${money(sum('recovered', list))}</td><td class="num">${money(sum('outstanding', list))}</td><td class="hide-mobile"></td></tr></tfoot></table></div>`
        : emptyState('loan', loans.length ? 'No loans match these filters.' : 'No loans yet. Use “Give a loan” to pay money to a person.');
      $$('[data-loan]', el).forEach((r) => r.addEventListener('click', () => openLoanDetail(r.dataset.loan)));
    };
    draw();
    $('#ln-q', el).addEventListener('input', (e) => ((f.q = e.target.value), draw()));
    $('#ln-status', el).addEventListener('change', (e) => ((f.status = e.target.value), draw()));
    $('#ln-new', el).addEventListener('click', () => openAddEntry({ type: 'loan_given' }));
    $('#ln-rec', el)?.addEventListener('click', () => openAddEntry({ type: 'loan_recovery' }));
    if (param) openLoanDetail(param);
  }

  const loanEntries = (id) =>
    S.data.transactions.filter((t) => t.loanId === id).sort((a, b) => (a.dateISO < b.dateISO ? -1 : a.dateISO > b.dateISO ? 1 : a.voucherNo < b.voucherNo ? -1 : 1));

  function openLoanDetail(id) {
    const l = S.data.loans.find((x) => x.id === id);
    if (!l) return toast('Loan not found.', 'error');
    const entries = loanEntries(id);
    const pct = l.given > 0 ? Math.min(100, (l.recovered / l.given) * 100) : 0;
    const body = `
      <div class="row">${loanChip(l)}<span class="spacer"></span><span style="font-family:var(--font-head);font-size:22px;font-weight:600">${money(l.outstanding)}</span></div>
      <div class="small muted" style="text-align:right;margin-top:-8px">outstanding</div>
      <dl class="kv">
        <dt>Borrower</dt><dd><b>${esc(l.borrower)}</b>${l.mobile ? ` · ${esc(l.mobile)}` : ''}</dd>
        ${l.purpose ? `<dt>Purpose</dt><dd>${esc(l.purpose)}</dd>` : ''}
        <dt>Paid out</dt><dd>${money(l.given)}${l.pendingGiven ? ` <span class="muted">(+${esc(money(l.pendingGiven))} awaiting approval/posting)</span>` : ''}</dd>
        <dt>Recovered</dt><dd>${money(l.recovered)}${l.pendingRecovery ? ` <span class="muted">(${esc(money(l.pendingRecovery))} awaiting approval/posting)</span>` : ''}</dd>
        <dt>Opened</dt><dd>${esc(fmtDateTime(l.createdAt))} by ${esc(userName(l.createdBy))}</dd>
      </dl>
      <div class="loan-track" title="${pct.toFixed(0)}% recovered"><div style="width:${pct}%"></div></div><div class="small muted" style="margin:-8px 0 12px">${pct.toFixed(0)}% recovered</div>
      <h4 style="font-size:13px;margin-bottom:6px">Payments and recoveries</h4>
      ${entries.length ? txTable(entries, { compact: true, showStatus: true }) : emptyState('list', 'No entries.')}`;
    const footer = [
      `<button class="btn" data-lx="print">${icon('print')}Print loan statement</button>`,
      l.status !== 'void' ? `<button class="btn" data-lx="more">${icon('down')}Pay more</button>` : '',
      l.outstanding > 0 ? `<button class="btn primary" data-lx="recover">${icon('up')}Record recovery</button>` : '',
    ].join('');
    const m = openModal({ title: `Loan ${l.loanNo} · ${l.borrower}`, body, footer, wide: true });
    $$('[data-lx]', m.el).forEach((b) =>
      b.addEventListener('click', () => {
        const x = b.dataset.lx;
        if (x === 'print') {
          const win = window.open('', '_blank');
          if (!win) return toast('Please allow pop-ups for this site to print the statement.', 'error');
          win.document.write(loanStatementHtml(l));
          win.document.close();
          return;
        }
        m.close();
        openAddEntry({ type: x === 'more' ? 'loan_given' : 'loan_recovery', loanId: l.id });
      }),
    );
  }

  function loanStatementHtml(l) {
    const rows = loanEntries(l.id).filter((t) => t.status === 'posted');
    let run = 0;
    let paid = 0;
    let got = 0;
    const m = (n) => money(n);
    const body = rows
      .map((t) => {
        // Paid out raises what is owed; recovered lowers it.
        const out = t.kind === 'loan_given' ? t.amount : 0;
        const back = t.kind === 'loan_recovery' ? t.amount : 0;
        run += out - back;
        paid += out;
        got += back;
        return `<tr><td>${esc(t.date)}</td><td>${esc(t.voucherNo)}</td><td>${esc(t.description)}<div class="s">${esc(loanCashAccount(t))}</div></td><td class="n">${out ? m(out) : ''}</td><td class="n">${back ? m(back) : ''}</td><td class="n">${m(run)}</td></tr>`;
      })
      .join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Loan Statement ${esc(l.loanNo)} — ${esc(S.company)}</title>
      <style>
        body{font:12px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1b1a2b;margin:28px}
        .head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #171735;padding-bottom:12px}
        h1{font-size:24px;margin:0;letter-spacing:.02em} h2{font-size:15px;margin:2px 0 0;color:#6558d3;font-weight:600}
        .meta{text-align:right;color:#55536b}
        .boxes{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:10px;margin:16px 0}
        .box{border:1px solid #d9d8e5;border-radius:8px;padding:9px 11px}.box b{display:block;font-size:14px;margin-top:3px}
        .box span{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#6b6985}
        table{width:100%;border-collapse:collapse}th{background:#171735;color:#fff;text-align:left;padding:7px 8px;font-size:11px}
        td{padding:6px 8px;border-bottom:1px solid #e6e5ef;vertical-align:top}.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
        tfoot td{font-weight:700;border-top:2px solid #171735}.s{color:#8a88a0;font-size:10.5px}
        .sig{display:grid;grid-template-columns:repeat(3,1fr);gap:40px;margin-top:60px}
        .sig div{border-top:1px solid #1b1a2b;padding-top:6px;text-align:center;color:#55536b}
        .foot{margin-top:24px;color:#8a88a0;font-size:10.5px;text-align:center}
        @media print{body{margin:12mm}}
      </style></head><body>
      <div class="head"><div><h1>${esc(S.company)}</h1><h2>Loan Statement · ${esc(l.loanNo)}</h2></div>
        <div class="meta"><div><b>Borrower:</b> ${esc(l.borrower)}</div>${l.mobile ? `<div><b>Mobile:</b> ${esc(l.mobile)}</div>` : ''}${l.purpose ? `<div><b>Purpose:</b> ${esc(l.purpose)}</div>` : ''}<div>Generated ${esc(fmtDateTime(new Date().toISOString()))} by ${esc(S.me.fullName)}</div></div></div>
      <div class="boxes">
        <div class="box"><span>Paid out</span><b>${m(l.given)}</b></div>
        <div class="box"><span>Recovered</span><b>${m(l.recovered)}</b></div>
        <div class="box"><span>Outstanding</span><b>${m(l.outstanding)}</b></div>
        <div class="box"><span>Status</span><b>${esc(LOAN_STATUS[l.status][0])}</b></div>
      </div>
      <table><thead><tr><th>Date</th><th>Voucher</th><th>Description</th><th class="n">Paid out</th><th class="n">Recovered</th><th class="n">Outstanding</th></tr></thead>
        <tbody>${body || '<tr><td colspan="6" style="text-align:center;padding:20px;color:#8a88a0">No posted entries yet.</td></tr>'}</tbody>
        <tfoot><tr><td colspan="3">Totals · ${rows.length} entries</td><td class="n">${m(paid)}</td><td class="n">${m(got)}</td><td class="n">${m(run)}</td></tr></tfoot></table>
      <div class="sig"><div>Borrower's signature</div><div>Prepared by</div><div>Approved by</div></div>
      <div class="foot">${esc(S.company)} · Ledger Book · Computer-generated statement of posted loan entries</div>
      <script>window.onload=function(){setTimeout(function(){window.print()},300)}<\/script>
      </body></html>`;
  }

  // ---------------------------------------------------------------------------
  // Approvals
  // ---------------------------------------------------------------------------
  function renderApprovals(el, param) {
    const me = S.me.id;
    const all = S.data.transactions;
    const tabs = [
      ['approve', 'Awaiting my approval', all.filter((t) => t.status === 'pending_approval' && t.approverId === me)],
      ['post', 'Ready for my final posting', all.filter((t) => t.status === 'approved' && t.initiatedBy === me)],
      ['mine', 'My requests', all.filter((t) => t.initiatedBy === me && !t.autoPosted)],
    ];
    if (isSuper()) tabs.push(['company', 'All unposted (company)', all.filter((t) => ['pending_approval', 'approved'].includes(t.status))]);
    let active = param || S.approvalsTab;
    if (!tabs.some((t) => t[0] === active)) active = tabs[0][2].length || !tabs[1][2].length ? 'approve' : 'post';
    S.approvalsTab = active;
    const [, , list] = tabs.find((t) => t[0] === active);
    const explain = {
      approve: 'Transactions that exceed the initiator’s delegated limit and are routed to you because your limit covers the amount.',
      post: 'Your own transactions that have been approved. Complete the final posting to enter them in the ledger.',
      mine: 'Everything you initiated that needed approval, with its current status.',
      company: 'Every transaction in the company still awaiting approval or final posting.',
    }[active];
    el.innerHTML = `
      <div class="tabs">${tabs.map(([k, l, arr]) => `<button data-tab="${k}" class="${k === active ? 'on' : ''}">${esc(l)}${arr.length && k !== 'mine' ? `<span class="badge ${k === 'company' ? 'soft' : ''}">${arr.length}</span>` : ''}</button>`).join('')}</div>
      <p class="muted" style="margin:-6px 0 14px">${esc(explain)}</p>
      <div class="queue">${list.length ? list.map((t) => approvalCard(t, active)).join('') : `<div class="card">${emptyState('check', 'Nothing here right now.')}</div>`}</div>`;
    $$('.tabs button', el).forEach((b) => b.addEventListener('click', () => (location.hash = `#/approvals/${b.dataset.tab}`)));
    $$('[data-qa]', el).forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = S.data.transactions.find((x) => x.id === b.dataset.id);
        runTxAction(t, b.dataset.qa);
      }),
    );
  }

  function approvalCard(t, tab) {
    const where = t.type === 'transfer' ? `${esc(t.account)} → ${esc(t.toAccount)}` : esc(t.account);
    const initiator = S.data.directory.find((u) => u.id === t.initiatedBy);
    let actions = '';
    if (tab === 'approve')
      actions = `<button class="btn ghost-danger sm" data-qa="reject" data-id="${t.id}">${icon('reject')}Reject</button><button class="btn positive sm" data-qa="approve" data-id="${t.id}">${icon('check')}Approve</button>`;
    else if (tab === 'post')
      actions = `<button class="btn ghost-danger sm" data-qa="cancel" data-id="${t.id}">Withdraw</button><button class="btn primary sm" data-qa="post" data-id="${t.id}">${icon('send')}Final post</button>`;
    return `<div class="card qcard click" data-act="open-tx" data-id="${t.id}" style="cursor:pointer">
      <div>
        <div class="row">${statusChip(t.status)}<span class="sub">${esc(t.voucherNo)} · ${esc(TYPE_LABEL[t.kind || t.type])}</span></div>
        <div class="desc" style="margin-top:6px">${esc(t.description)}</div>
        <div class="meta">
          <span>${esc(t.date)}</span><span>${where}</span><span>${esc(t.category)}</span>
          <span>Initiated by <b>${esc(userName(t.initiatedBy))}</b>${initiator && tab === 'approve' ? ` (limit ${esc(money(initiator.financialLimit))})` : ''}</span>
          ${t.approverId && tab !== 'approve' ? `<span>Approver: <b>${esc(userName(t.approverId))}</b></span>` : ''}
          ${t.decisionRemark ? `<span>Remark: “${esc(t.decisionRemark)}”</span>` : ''}
        </div>
      </div>
      <div style="text-align:right"><div class="amount">${money(t.amount)}</div><div class="actions" style="margin-top:8px">${actions}</div></div>
    </div>`;
  }

  // ---------------------------------------------------------------------------
  // Budgets
  // ---------------------------------------------------------------------------
  function renderBudgets(el) {
    const budgets = S.data.settings.budgets || [];
    const now = new Date();
    const monthKey = isoLocal(now).slice(0, 7);
    const spentBy = new Map();
    for (const t of postedTx()) if (t.type === 'expense' && t.dateISO.startsWith(monthKey)) spentBy.set(t.category, (spentBy.get(t.category) || 0) + t.amount);
    const totalLimit = budgets.reduce((a, b) => a + b.limit, 0);
    const totalSpent = budgets.reduce((a, b) => a + (spentBy.get(b.category) || 0), 0);
    const over = budgets.filter((b) => (spentBy.get(b.category) || 0) > b.limit).length;
    el.innerHTML = `
      <div class="stack">
        <div class="cards">
          <div class="card stat"><div class="label">Budgeted this month</div><div class="value">${money(totalLimit)}</div></div>
          <div class="card stat"><div class="label">Spent against budgets</div><div class="value">${money(totalSpent)}</div></div>
          <div class="card stat"><div class="label">Over budget</div><div class="value" style="color:${over ? 'var(--danger)' : 'var(--positive)'}">${over} of ${budgets.length}</div></div>
        </div>
        <div class="card">
          <div class="card-h"><h3>Monthly budgets · ${now.toLocaleString('en-US', { month: 'long', year: 'numeric' })}</h3><span class="spacer"></span>
            ${isSuper() ? `<button class="btn sm primary" id="b-add">${icon('plus')}Add budget</button>` : '<span class="small muted">Budgets are set by Super Users</span>'}</div>
          <div class="card-b">${
            budgets.length
              ? budgets
                  .map((b, i) => {
                    const s = spentBy.get(b.category) || 0;
                    const pct = (s / b.limit) * 100;
                    return `<div style="padding:12px 0;border-bottom:1px solid var(--line)">
                      <div class="row"><b>${esc(b.category)}</b><span class="spacer"></span><span class="num">${money(s)} <span class="muted">of ${money(b.limit)}</span></span>
                      ${isSuper() ? `<button class="btn sm" data-b-edit="${i}">${icon('edit')}</button><button class="btn sm ghost-danger" data-b-del="${i}">${icon('trash')}</button>` : ''}</div>
                      <div class="progress ${pct > 100 ? 'over' : pct > 80 ? 'warn' : ''}" style="margin-top:8px"><div style="width:${Math.min(100, pct)}%"></div></div>
                      <div class="small ${pct > 100 ? '' : 'muted'}" style="margin-top:4px;${pct > 100 ? 'color:var(--danger)' : ''}">${pct > 100 ? `Over by ${money(s - b.limit)}` : `${money(b.limit - s)} left · ${pct.toFixed(0)}% used`}</div>
                    </div>`;
                  })
                  .join('')
              : emptyState('target', 'No budgets yet.')
          }</div>
        </div>
      </div>`;
    const save = async (list) => {
      await api('/api/settings', { method: 'PUT', body: { key: 'budgets', value: list } });
      await refreshAll();
    };
    const edit = (i) => {
      const b = i === null ? { category: '', limit: '' } : budgets[i];
      const m = openModal({
        title: i === null ? 'Add budget' : 'Edit budget',
        body: `<label class="field"><span>Category</span><select class="input" id="bg-cat">${S.data.settings.categories.map((c) => `<option${c === b.category ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
          <label class="field"><span>Monthly limit (${esc(S.currency)})</span><input class="input num" id="bg-limit" inputmode="decimal" value="${esc(b.limit)}"></label>`,
        footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="bg-ok">Save</button>`,
      });
      $('#bg-ok', m.el).addEventListener('click', (e) =>
        withBusy(e.currentTarget, async () => {
          const nb = { category: $('#bg-cat', m.el).value, limit: Number($('#bg-limit', m.el).value.replace(/[,\s]/g, '')) };
          if (!(nb.limit > 0)) throw new Error('Enter a monthly limit greater than zero.');
          const list = budgets.filter((x, j) => j !== i && x.category !== nb.category);
          list.push(nb);
          await save(list);
          m.close();
          toast('Budget saved.');
        }),
      );
    };
    if (isSuper()) {
      $('#b-add', el).addEventListener('click', () => edit(null));
      $$('[data-b-edit]', el).forEach((b) => b.addEventListener('click', () => edit(+b.dataset.bEdit)));
      $$('[data-b-del]', el).forEach((b) =>
        b.addEventListener('click', async () => {
          const i = +b.dataset.bDel;
          if (!(await confirmModal({ title: 'Remove budget', message: `Remove the budget for <b>${esc(budgets[i].category)}</b>?`, confirmLabel: 'Remove', danger: true }))) return;
          await save(budgets.filter((x, j) => j !== i)).catch((err) => toast(err.message, 'error'));
        }),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Documents
  // ---------------------------------------------------------------------------
  function renderDocuments(el) {
    const docs = S.data.documents;
    const attached = new Map(S.data.transactions.filter((t) => t.documentId).map((t) => [t.documentId, t]));
    const size = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
    el.innerHTML = `
      <div class="card">
        <div class="card-h"><h3>Document vault</h3><span class="spacer"></span>
          ${S.data.documentsEnabled ? `<label class="btn sm primary">${icon('upload')}Upload<input type="file" id="d-up" hidden></label>` : ''}</div>
        <div class="card-b">
          ${S.data.documentsEnabled ? '' : `<div class="alert info">${icon('info')}<span>Document storage (Cloudflare R2) is not enabled on this deployment.</span></div>`}
          ${
            docs.length
              ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>File</th><th class="hide-mobile">Uploaded by</th><th class="hide-mobile">Date</th><th>Attached to</th><th class="num">Size</th><th></th></tr></thead><tbody>
            ${docs
              .map((d) => {
                const t = attached.get(d.id);
                return `<tr><td><div class="desc">${esc(d.filename)}</div><div class="sub">${esc(d.mimeType || 'file')}</div></td>
                  <td class="hide-mobile">${esc(userName(d.uploadedBy))}</td><td class="hide-mobile">${esc(fmtDateTime(d.createdAt))}</td>
                  <td>${t ? `<a href="#" data-act="open-tx" data-id="${t.id}">${esc(t.voucherNo)}</a>` : '<span class="muted">—</span>'}</td>
                  <td class="num">${size(d.size)}</td>
                  <td class="num"><a class="btn sm" href="/api/documents/${d.id}/file" target="_blank" rel="noopener" title="View">${icon('eye')}</a>
                  ${!t && (d.uploadedBy === S.me.id || isSuper()) ? `<button class="btn sm ghost-danger" data-del="${d.id}" title="Delete">${icon('trash')}</button>` : ''}</td></tr>`;
              })
              .join('')}</tbody></table></div>`
              : emptyState('file', 'No documents yet. Attach a voucher when adding an entry, or upload here.')
          }
        </div>
      </div>`;
    const up = $('#d-up', el);
    if (up)
      up.addEventListener('change', async () => {
        if (!up.files[0]) return;
        const fd = new FormData();
        fd.append('file', up.files[0]);
        try {
          await api('/api/documents', { method: 'POST', body: fd, raw: true });
          toast('Document uploaded.');
          await refreshAll();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    $$('[data-del]', el).forEach((b) =>
      b.addEventListener('click', async () => {
        if (!(await confirmModal({ title: 'Delete document', message: 'Delete this document permanently?', confirmLabel: 'Delete', danger: true }))) return;
        try {
          await api(`/api/documents/${b.dataset.del}`, { method: 'DELETE' });
          toast('Document deleted.');
          await refreshAll();
        } catch (err) {
          toast(err.message, 'error');
        }
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------
  async function renderMessages(el) {
    if (!S.notifications) S.notifications = (await api('/api/notifications')).notifications;
    const list = S.notifications;
    const kindIcon = { approval_request: 'clock', ready_to_post: 'send', rejected: 'reject', limit_changed: 'shield', reroute_needed: 'users', info: 'info' };
    el.innerHTML = `
      <div class="card">
        <div class="card-h"><h3>Messages</h3><span class="spacer"></span>${list.some((n) => !n.read) ? `<button class="btn sm" id="m-all">Mark all as read</button>` : ''}</div>
        <div class="card-b" style="padding:8px 0 4px">${
          list.length
            ? list
                .map(
                  (n) => `<div class="msg kind-${esc(n.kind)} ${n.read ? '' : 'unread'}" data-id="${n.id}" data-tx="${n.transactionId || ''}">
                  <div class="ico">${icon(kindIcon[n.kind] || 'info')}</div>
                  <div style="min-width:0;flex:1"><div class="msg-title">${esc(n.title)}</div><div class="msg-body">${esc(n.body || '')}</div>
                  <div class="msg-time">${esc(fmtDateTime(n.createdAt))}${n.actionable ? ' · <b style="color:var(--caution)">Action needed</b>' : ''}</div></div></div>`,
                )
                .join('')
            : emptyState('bell', 'No messages yet. You will be notified here whenever a transaction needs your action.')
        }</div>
      </div>`;
    $('#m-all', el)?.addEventListener('click', async () => {
      await api('/api/notifications/read', { method: 'POST', body: { all: true } });
      S.notifications = null;
      await loadMe();
      rerender();
    });
    $$('.msg', el).forEach((row) =>
      row.addEventListener('click', async () => {
        const n = list.find((x) => x.id === row.dataset.id);
        if (!n.read) {
          n.read = true;
          row.classList.remove('unread');
          api('/api/notifications/read', { method: 'POST', body: { ids: [n.id] } }).then(loadMe).then(renderNav).catch(() => {});
        }
        if (row.dataset.tx && isFinancial()) openTxDetail(row.dataset.tx);
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Phone browser notifications
  // ---------------------------------------------------------------------------
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const keyBytes = (b64u) => {
    const s = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64u.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  };
  async function pushSubscription() {
    if (!pushSupported()) return null;
    const reg = await navigator.serviceWorker.getRegistration('/');
    return reg ? reg.pushManager.getSubscription() : null;
  }
  async function pushEnable() {
    if (!S.pushKey) throw new Error('Phone notifications are not set up on this server yet. Ask the Admin.');
    if (!pushSupported()) {
      throw new Error(isIOS() && !isStandalone()
        ? 'On iPhone, first tap Share → “Add to Home Screen”, open the Ledger Book from the Home Screen icon, then turn notifications on.'
        : 'This browser does not support notifications. Use Chrome, Edge, Samsung Internet or Firefox.');
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in the browser’s site settings, then try again.');
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      // A subscription made with an older server key cannot be used.
      const cur = sub.options && sub.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
      const want = keyBytes(S.pushKey);
      if (!cur || cur.length !== want.length || cur.some((b, i) => b !== want[i])) {
        await sub.unsubscribe();
        sub = null;
      }
    }
    if (!sub) {
      try {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(S.pushKey) });
      } catch (err) {
        throw new Error(`This browser could not register for notifications (${err.message}). Check that notifications are allowed for this site, or try Chrome.`);
      }
    }
    await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
  }
  async function pushDisable() {
    const sub = await pushSubscription();
    if (sub) {
      await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe();
    }
  }
  // Signing out: stop this device receiving this person's alerts (signing in again re-links it).
  async function pushForgetDevice() {
    const sub = await pushSubscription();
    if (sub) await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
  }
  // On every start, keep the server's record of this device in step.
  async function pushSync() {
    if (!S.pushKey || !pushSupported() || Notification.permission !== 'granted') return;
    const sub = await pushSubscription();
    if (sub) await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() }).catch(() => {});
  }

  async function phoneCard() {
    const u = S.me;
    const sub = await pushSubscription().catch(() => null);
    const on = !!sub && pushSupported() && Notification.permission === 'granted';
    let devices = [];
    try {
      devices = (await api('/api/push/devices')).devices;
    } catch {
      /* ignore */
    }
    let status;
    if (!S.pushKey) status = `<div class="alert info">${icon('info')}<span>Phone notifications are not set up on this server yet.${u.role === 'admin' ? ' See the Help page, section “Phone notifications”.' : ' Ask the Admin.'}</span></div>`;
    else if (on) status = `<div class="alert positive">${icon('check')}<span><b>On for this device.</b> You will get an alert when your approval is needed, when your entry is approved for final posting, when it is rejected, and when your limit changes.</span></div>`;
    else if (isIOS() && !isStandalone()) status = `<div class="alert caution">${icon('info')}<span><b>iPhone:</b> tap Share → <b>Add to Home Screen</b>, open the Ledger Book from that icon, then come back here and turn notifications on.</span></div>`;
    else status = `<div class="alert caution">${icon('bell')}<span><b>Off for this device.</b> Turn on to get an alert on this phone or computer when your action is needed.</span></div>`;
    return `<div class="card"><div class="card-h"><h3>Phone notifications</h3></div><div class="card-b stack" style="gap:12px">
      <dl class="kv"><dt>Mobile number</dt><dd>${u.mobile ? esc(u.mobile) : '<span class="muted">Not recorded — ask the Admin to add it</span>'}</dd></dl>
      ${status}
      ${S.pushKey ? `<div class="row">${on ? `<button class="btn" id="push-test">${icon('send')}Send a test notification</button><button class="btn ghost-danger" id="push-off">Turn off on this device</button>` : `<button class="btn primary" id="push-on">${icon('bell')}Turn on notifications for this device</button>`}</div>` : ''}
      ${devices.length ? `<div class="small muted">Devices receiving your alerts: ${devices.map((d) => esc(d.device)).join(' · ')}</div>` : ''}
    </div></div>`;
  }
  function bindPhoneCard(el) {
    $('#push-on', el)?.addEventListener('click', (e) =>
      withBusy(e.currentTarget, async () => {
        await pushEnable();
        toast('Phone notifications are on for this device.');
        rerender();
      }),
    );
    $('#push-off', el)?.addEventListener('click', (e) =>
      withBusy(e.currentTarget, async () => {
        await pushDisable();
        toast('Phone notifications turned off for this device.');
        rerender();
      }),
    );
    $('#push-test', el)?.addEventListener('click', (e) =>
      withBusy(e.currentTarget, async () => {
        const r = await api('/api/push/test', { method: 'POST', body: {} });
        toast(r.result.status === 'sent' ? 'Test sent — it should appear in a few seconds.' : `Not delivered: ${r.result.detail}`, r.result.status === 'sent' ? '' : 'error');
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Users (Admin)
  // ---------------------------------------------------------------------------
  async function loadUsers() {
    if (!S.users) S.users = (await api('/api/users')).users;
    return S.users;
  }
  async function renderUsers(el) {
    const users = await loadUsers();
    el.innerHTML = `
      <div class="stack">
        <div class="alert info">${icon('info')}<span>As Admin you create Users and Super Users and manage their access. You hold <b>no financial authority</b>: financial limits are delegated only by Super Users.</span></div>
        <div class="card">
          <div class="card-h"><h3>People</h3><span class="spacer"></span><button class="btn sm primary" data-act="new-user">${icon('plus')}New user</button></div>
          <div class="card-b"><div class="table-wrap"><table class="tbl">
            <thead><tr><th>Name</th><th>Role</th><th class="num hide-mobile">Financial limit</th><th>Status</th><th></th></tr></thead>
            <tbody>${users
              .map(
                (u) => `<tr>
                <td><div class="desc">${esc(u.fullName)}</div><div class="sub">@${esc(u.username)}${u.designation ? ' · ' + esc(u.designation) : ''}</div><div class="sub">${u.mobile ? esc(u.mobile) : u.role === 'admin' ? '' : '<span style="color:var(--danger)">No mobile number — click Edit to add</span>'}</div></td>
                <td><span class="chip role">${ROLE_LABEL[u.role]}</span></td>
                <td class="num hide-mobile">${u.role === 'admin' ? '<span class="muted">None</span>' : money(u.financialLimit)}</td>
                <td>${u.active ? '<span class="chip posted">Active</span>' : '<span class="chip cancelled">Disabled</span>'}${u.mustChangePassword ? ' <span class="chip neutral">Temp password</span>' : ''}</td>
                <td class="num">${u.role === 'admin' ? '' : `<button class="btn sm" data-u-edit="${u.id}">${icon('edit')}Edit</button> <button class="btn sm" data-u-pw="${u.id}">${icon('key')}Reset</button> <button class="btn sm ${u.active ? 'ghost-danger' : ''}" data-u-toggle="${u.id}">${u.active ? 'Disable' : 'Enable'}</button>`}</td>
              </tr>`,
              )
              .join('')}</tbody></table></div></div>
        </div>
        <div id="push-admin"></div>
      </div>`;
    loadPushAdmin($('#push-admin', el), users);
    $$('[data-u-edit]', el).forEach((b) => b.addEventListener('click', () => openUserEditor(users.find((u) => u.id === b.dataset.uEdit))));
    $$('[data-u-pw]', el).forEach((b) => b.addEventListener('click', () => openResetPassword(users.find((u) => u.id === b.dataset.uPw))));
    $$('[data-u-toggle]', el).forEach((b) =>
      b.addEventListener('click', async () => {
        const u = users.find((x) => x.id === b.dataset.uToggle);
        const ok = await confirmModal({
          title: u.active ? 'Disable user' : 'Enable user',
          message: u.active
            ? `Disable <b>${esc(u.fullName)}</b>? They are signed out immediately. Anyone waiting on their approval will be asked to choose another approver.`
            : `Enable <b>${esc(u.fullName)}</b> so they can sign in again?`,
          confirmLabel: u.active ? 'Disable' : 'Enable',
          danger: u.active,
        });
        if (!ok) return;
        try {
          await api(`/api/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } });
          toast(`${u.fullName} ${u.active ? 'disabled' : 'enabled'}.`);
          S.users = null;
          rerender();
        } catch (err) {
          toast(err.message, 'error');
        }
      }),
    );
  }

  async function loadPushAdmin(box, users) {
    let r;
    try {
      r = await api('/api/push/log');
    } catch {
      return;
    }
    const people = users.filter((u) => u.role !== 'admin' && u.active);
    const label = { sent: 'Delivered', no_device: 'No device', failed: 'Failed', skipped: 'Not set up', pending: 'Waiting', sending: 'Sending' };
    box.innerHTML = `<div class="card"><div class="card-h"><h3>Phone notifications</h3><span class="spacer"></span>${r.configured ? '<span class="chip posted">Set up</span>' : '<span class="chip cancelled">Not set up</span>'}</div><div class="card-b stack" style="gap:14px">
      ${r.configured ? '' : `<div class="alert info">${icon('info')}<span>Run <code>node scripts/setup-push.mjs</code> on the deployment PC to switch phone notifications on (Help → Phone notifications).</span></div>`}
      <div class="small muted">Each person turns notifications on themselves, in Settings on their phone. Devices turned on: ${r.devices.map((d) => `${esc(d.userName)} <b>${d.devices}</b>`).join(' · ') || 'none'}</div>
      ${r.configured && people.length ? `<div class="row" style="flex-wrap:nowrap"><select class="input" id="pa-user" style="max-width:320px">${people.map((u) => `<option value="${u.id}">${esc(u.fullName)}</option>`).join('')}</select><button class="btn" id="pa-test">${icon('send')}Send test notification</button></div>` : ''}
      ${r.log.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>When</th><th>To</th><th>Message</th><th>Result</th></tr></thead><tbody>${r.log
        .slice(0, 20)
        .map((l) => `<tr><td class="small" style="white-space:nowrap">${esc(fmtDateTime(l.createdAt))}</td><td>${esc(l.userName || '')}</td><td class="small">${esc(l.title)}</td><td class="small"><b>${esc(label[l.pushStatus] || l.pushStatus)}</b>${l.pushDetail ? `<div class="muted">${esc(l.pushDetail)}</div>` : ''}</td></tr>`)
        .join('')}</tbody></table></div>` : '<div class="small muted">No phone notifications sent yet.</div>'}
    </div></div>`;
    $('#pa-test', box)?.addEventListener('click', (e) =>
      withBusy(e.currentTarget, async () => {
        const res = await api('/api/push/test', { method: 'POST', body: { userId: $('#pa-user', box).value } });
        toast(res.result.status === 'sent' ? `Test delivered: ${res.result.detail}.` : `Not delivered: ${res.result.detail}`, res.result.status === 'sent' ? '' : 'error');
        loadPushAdmin(box, users);
      }),
    );
  }

  const genPassword = () => {
    const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
    const d = '23456789';
    const r = (s) => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
    return Array.from({ length: 7 }, () => r(a)).join('') + r(d) + r(d) + r(d);
  };

  function openUserEditor(u) {
    const isNew = !u;
    const m = openModal({
      title: isNew ? 'Create user' : `Edit ${u.fullName}`,
      body: `
        <label class="field"><span>Role *</span>
          <div class="segmented full" id="ue-role"><button data-r="user">User</button><button data-r="miduser">Mid User</button><button data-r="superuser">Super User</button></div></label>
        <div class="small muted" id="ue-role-help"></div>
        <div class="grid-2">
          <label class="field"><span>Full name *</span><input class="input" id="ue-name" maxlength="80" value="${esc(u?.fullName || '')}"></label>
          <label class="field"><span>Designation</span><input class="input" id="ue-desig" maxlength="80" value="${esc(u?.designation || '')}" placeholder="e.g. Accounts Officer"></label>
        </div>
        <label class="field"><span>Mobile number *</span><input class="input" id="ue-mobile" type="tel" inputmode="tel" maxlength="20" autocomplete="off" value="${esc(u?.mobile || '')}" placeholder="e.g. 01712345678"></label>
        ${
          isNew
            ? `<div class="grid-2">
          <label class="field"><span>Username *</span><input class="input" id="ue-user" maxlength="32" autocomplete="off" placeholder="e.g. rahim.k"></label>
          <label class="field"><span>Temporary password *</span><div class="row" style="flex-wrap:nowrap"><input class="input" id="ue-pw" autocomplete="new-password" value="${genPassword()}"><button class="btn" id="ue-gen" type="button" title="Generate">↻</button></div></label>
        </div>
        <div class="small muted">The user must change this password at first sign-in. Share it privately. Their financial limit starts at ${esc(money(0))} until a Super User delegates one.</div>`
            : ''
        }`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="ue-ok">${isNew ? 'Create user' : 'Save'}</button>`,
    });
    let role = u?.role || 'user';
    const help = {
      user: 'User — initiates transactions; posts directly within the delegated limit, and can approve others’ transactions up to that limit. Uses existing categories and tags only.',
      miduser: 'Mid User — everything a User can do, plus adds new categories and tags. Cannot assign financial limits; their own limit is set by a Super User.',
      superuser: 'Super User — everything a User can do, plus assigns financial limits to other users, manages budgets and ledger settings.',
    };
    const setRole = (r) => {
      role = r;
      $$('#ue-role button', m.el).forEach((b) => b.classList.toggle('on', b.dataset.r === r));
      $('#ue-role-help', m.el).textContent = help[r];
    };
    $$('#ue-role button', m.el).forEach((b) => b.addEventListener('click', () => setRole(b.dataset.r)));
    setRole(role);
    $('#ue-gen', m.el)?.addEventListener('click', () => ($('#ue-pw', m.el).value = genPassword()));
    $('#ue-ok', m.el).addEventListener('click', (e) =>
      withBusy(e.currentTarget, async () => {
        const mobile = $('#ue-mobile', m.el).value.trim();
        if (!mobile) throw new Error('Mobile number is required.');
        const body = { fullName: $('#ue-name', m.el).value, designation: $('#ue-desig', m.el).value, mobile, role };
        if (isNew) {
          body.username = $('#ue-user', m.el).value;
          body.password = $('#ue-pw', m.el).value;
          const r = await api('/api/users', { method: 'POST', body });
          toast(`${r.user.fullName} created as ${ROLE_LABEL[r.user.role]}. Username: ${r.user.username}`);
        } else {
          await api(`/api/users/${u.id}`, { method: 'PATCH', body });
          toast('User updated.');
        }
        m.close();
        S.users = null;
        if (S.view === 'users') rerender();
        else location.hash = '#/users';
      }),
    );
  }

  function openResetPassword(u) {
    const m = openModal({
      title: `Reset password · ${u.fullName}`,
      body: `<div>Set a new temporary password. ${esc(u.fullName)} is signed out and must change it at next sign-in.</div>
        <label class="field"><span>Temporary password</span><input class="input" id="rp-pw" value="${genPassword()}" autocomplete="new-password"></label>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="rp-ok">Reset password</button>`,
    });
    $('#rp-ok', m.el).addEventListener('click', (e) =>
      withBusy(e.currentTarget, async () => {
        await api(`/api/users/${u.id}/reset-password`, { method: 'POST', body: { password: $('#rp-pw', m.el).value } });
        m.close();
        toast('Password reset. Share the temporary password privately.');
        S.users = null;
        rerender();
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Financial limits (Super User)
  // ---------------------------------------------------------------------------
  async function renderLimits(el) {
    const users = (await loadUsers()).filter((u) => u.role !== 'admin');
    if (!S.limitHistory) S.limitHistory = (await api('/api/limit-history')).history;
    el.innerHTML = `
      <div class="stack">
        <div class="alert info">${icon('shield')}<span>Delegate each person’s financial authority. Entries within a person’s limit post immediately; larger ones are routed to someone whose limit covers the amount, then return to the initiator for final posting. You cannot set your own limit — another Super User must.</span></div>
        <div class="card">
          <div class="card-h"><h3>Delegated limits</h3></div>
          <div class="card-b"><div class="table-wrap"><table class="tbl">
            <thead><tr><th>Name</th><th>Role</th><th class="num">Financial limit</th><th class="hide-mobile">Last set</th><th></th></tr></thead>
            <tbody>${users
              .map((u) => {
                const self = u.id === S.me.id;
                return `<tr>
                <td><div class="desc">${esc(u.fullName)}${self ? ' <span class="muted">(you)</span>' : ''}</div><div class="sub">@${esc(u.username)}${u.designation ? ' · ' + esc(u.designation) : ''}${u.active ? '' : ' · Disabled'}</div></td>
                <td><span class="chip role">${ROLE_LABEL[u.role]}</span></td>
                <td class="num"><b>${money(u.financialLimit)}</b></td>
                <td class="hide-mobile small muted">${u.limitSetAt ? `${esc(userName(u.limitSetBy))} · ${esc(fmtDateTime(u.limitSetAt))}` : 'Never'}</td>
                <td class="num">${self ? `<span class="small muted">${icon('lock')}</span>` : u.active ? `<button class="btn sm" data-l="${u.id}">${icon('edit')}Set limit</button>` : ''}</td></tr>`;
              })
              .join('')}</tbody></table></div></div>
        </div>
        <div class="card">
          <div class="card-h"><h3>Limit history</h3></div>
          <div class="card-b">${
            S.limitHistory.length
              ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>When</th><th>User</th><th class="num">From</th><th class="num">To</th><th class="hide-mobile">Set by</th><th class="hide-mobile">Note</th></tr></thead><tbody>
            ${S.limitHistory.map((h) => `<tr><td class="small">${esc(fmtDateTime(h.setAt))}</td><td>${esc(h.userName || '—')}</td><td class="num">${money(h.oldLimit)}</td><td class="num"><b>${money(h.newLimit)}</b></td><td class="hide-mobile">${esc(h.setByName || '—')}</td><td class="hide-mobile small">${esc(h.note || '')}</td></tr>`).join('')}
            </tbody></table></div>`
              : emptyState('history', 'No limits have been assigned yet.')
          }</div>
        </div>
      </div>`;
    $$('[data-l]', el).forEach((b) =>
      b.addEventListener('click', () => {
        const u = users.find((x) => x.id === b.dataset.l);
        const m = openModal({
          title: `Financial limit · ${u.fullName}`,
          body: `<div>Current limit: <b>${esc(money(u.financialLimit))}</b>. ${esc(u.fullName)} will be notified of the change.</div>
            <label class="field"><span>New limit (${esc(S.currency)})</span><input class="input num" id="lm-v" inputmode="decimal" value="${u.financialLimit || ''}"></label>
            <label class="field"><span>Note (optional)</span><input class="input" id="lm-n" maxlength="300" placeholder="e.g. Board resolution 12/2026"></label>`,
          footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="lm-ok">Assign limit</button>`,
        });
        $('#lm-ok', m.el).addEventListener('click', (e) =>
          withBusy(e.currentTarget, async () => {
            const v = $('#lm-v', m.el).value.replace(/[,\s]/g, '');
            if (v === '' || !(Number(v) >= 0)) throw new Error('Enter a limit of zero or more.');
            await api(`/api/users/${u.id}/limit`, { method: 'PUT', body: { limit: v, note: $('#lm-n', m.el).value } });
            m.close();
            toast(`Limit for ${u.fullName} set to ${money(Number(v))}.`);
            S.users = null;
            S.limitHistory = null;
            await loadState();
            rerender();
          }),
        );
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Audit trail
  // ---------------------------------------------------------------------------
  async function renderAudit(el) {
    if (!S.audit) S.audit = (await api('/api/audit')).entries;
    el.innerHTML = `
      <div class="card">
        <div class="filters"><input class="input search" id="a-q" placeholder="Filter by user, action or detail…"></div>
        <div class="card-b" id="a-list"></div>
      </div>`;
    const draw = (q = '') => {
      const list = S.audit.filter((a) => !q || `${a.actorName} ${a.action} ${a.detail}`.toLowerCase().includes(q.toLowerCase()));
      $('#a-list', el).innerHTML = list.length
        ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Detail</th></tr></thead><tbody>
          ${list.slice(0, 500).map((a) => `<tr><td class="small num" style="white-space:nowrap">${esc(fmtDateTime(a.at))}</td><td>${esc(a.actorName || '—')}</td><td><span class="chip neutral">${esc(a.action)}</span></td><td class="small">${esc(a.detail || '')}</td></tr>`).join('')}
          </tbody></table></div>`
        : emptyState('history', 'No audit entries match.');
    };
    draw();
    $('#a-q', el).addEventListener('input', (e) => draw(e.target.value));
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  function renderSettings(el) {
    const u = S.me;
    const theme = store.get('theme', 'system');
    let html = `
      <div class="stack">
        <div class="card"><div class="card-h"><h3>Your account</h3></div><div class="card-b">
          <dl class="kv">
            <dt>Signed in as</dt><dd>${esc(u.fullName)} (@${esc(u.username)})</dd>
            <dt>Role</dt><dd><span class="chip role">${ROLE_LABEL[u.role]}</span></dd>
            <dt>Financial limit</dt><dd>${u.role === 'admin' ? 'None — the Admin has no financial authority' : `${money(u.financialLimit)}${u.limitSetBy ? ` <span class="muted small">· set by ${esc(userName(u.limitSetBy))} on ${esc(fmtDateTime(u.limitSetAt))}</span>` : ''}`}</dd>
            <dt>Company</dt><dd>${esc(S.company)}</dd>
            <dt>Version</dt><dd><code>${esc(S.version || 'not stamped')}</code></dd>
          </dl>
          <div class="row" style="margin-top:14px">
            <button class="btn" data-act="change-password">${icon('key')}Change password</button>
            <a class="btn" href="/help" target="_blank" rel="noopener">${icon('help')}Help</a>
            <button class="btn" data-act="logout">${icon('logout')}Sign out</button>
            <span class="spacer"></span>
            <span class="small muted">${icon('moon')}</span>
            <div class="segmented" id="s-theme">${['system', 'light', 'dark'].map((t) => `<button data-th="${t}" class="${theme === t ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
          </div>
        </div></div>
        ${isFinancial() ? '<div id="phone-card"></div>' : ''}`;
    if (isFinancial()) {
      const st = S.data.settings;
      html += `
        <div class="grid-2">
          <div class="card"><div class="card-h"><h3>Categories</h3></div><div class="card-b">${listEditor('categories', st.categories)}</div></div>
          <div class="card"><div class="card-h"><h3>Accounts</h3></div><div class="card-b">${listEditor('accounts', st.accounts)}</div></div>
        </div>
        <div class="grid-2">
          <div class="card"><div class="card-h"><h3>Tags</h3></div><div class="card-b">
            <div>${S.data.tags.length ? S.data.tags.map((t) => `<span class="tag">${esc(t)} <span class="muted">${S.data.transactions.filter((x) => x.tags.includes(t)).length}</span>${isSuper() ? `<button data-tag-del="${esc(t)}" aria-label="Delete tag">×</button>` : ''}</span>`).join('') : '<span class="muted">No tags yet.</span>'}</div>
            ${canManageLists() ? `<div class="row" style="margin-top:12px;flex-wrap:nowrap"><input class="input" id="tag-new" maxlength="40" placeholder="New tag name"><button class="btn" id="tag-add">${icon('plus')}Add</button></div>` : '<div class="small muted" style="margin-top:10px">New tags are added by Mid Users and Super Users.</div>'}
          </div></div>
          <div class="card"><div class="card-h"><h3>Currency</h3></div><div class="card-b">
            <div class="row" style="flex-wrap:nowrap"><input class="input" id="cur" maxlength="5" value="${esc(st.currency)}" ${isSuper() ? '' : 'disabled'} style="max-width:120px"> ${isSuper() ? `<button class="btn" id="cur-save">Save</button>` : '<span class="small muted">Set by Super Users</span>'}</div>
            <div class="small muted" style="margin-top:8px">Symbol shown before every amount, e.g. ৳, Tk, BDT, $.</div>
          </div></div>
        </div>`;
      if (isSuper()) {
        html += `
        <div class="card"><div class="card-h"><h3>Backup & restore</h3></div><div class="card-b">
          <p class="muted" style="margin-top:0">A backup is a JSON file of all ledger data — transactions with their approval trail, tags, settings, document records and limit history. It never contains users or passwords.</p>
          <div class="row"><a class="btn" href="/api/backup">${icon('download')}Download a backup now</a>
          <label class="btn">${icon('upload')}Restore from a backup file<input type="file" id="restore-file" accept="application/json,.json" hidden></label></div>
        </div></div>`;
      }
    }
    html += '</div>';
    el.innerHTML = html;
    if (isFinancial())
      phoneCard().then((card) => {
      const box = $('#phone-card', el);
      if (!box) return;
      box.innerHTML = card;
      bindPhoneCard(box);
    });

    $$('#s-theme button', el).forEach((b) =>
      b.addEventListener('click', () => {
        store.set('theme', b.dataset.th);
        applyTheme();
        rerender();
      }),
    );
    if (!isFinancial()) return;
    bindListEditor(el, 'categories');
    bindListEditor(el, 'accounts');
    $('#tag-add', el)?.addEventListener('click', async () => {
      const name = $('#tag-new', el).value.trim();
      if (!name) return;
      try {
        await api('/api/tags', { method: 'POST', body: { name } });
        await refreshAll();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    $$('[data-tag-del]', el).forEach((b) =>
      b.addEventListener('click', async () => {
        if (!(await confirmModal({ title: 'Delete tag', message: `Delete the tag <b>${esc(b.dataset.tagDel)}</b>? Existing transactions keep their tag text.`, confirmLabel: 'Delete', danger: true }))) return;
        try {
          await api(`/api/tags/${encodeURIComponent(b.dataset.tagDel)}`, { method: 'DELETE' });
          await refreshAll();
        } catch (err) {
          toast(err.message, 'error');
        }
      }),
    );
    $('#cur-save', el)?.addEventListener('click', async () => {
      try {
        await api('/api/settings', { method: 'PUT', body: { key: 'currency', value: $('#cur', el).value } });
        toast('Currency updated.');
        await refreshAll();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    $('#restore-file', el)?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      let backup;
      try {
        backup = JSON.parse(await file.text());
      } catch {
        return toast('That file is not valid JSON.', 'error');
      }
      if (backup.app !== 'alidada-ledger-book') return toast('That is not an ALIDADA Ledger Book backup.', 'error');
      const n = backup.data?.transactions?.length || 0;
      const ok = await confirmModal({
        title: 'Restore from backup',
        message: `This backup was exported on <b>${esc(fmtDateTime(backup.exportedAt))}</b> by ${esc(backup.exportedBy || 'unknown')} and contains <b>${n}</b> transactions and ${backup.data?.documents?.length || 0} document records.<br><br><b>All current ledger data will be replaced.</b> Users and passwords are not affected.`,
        confirmLabel: 'Restore',
        danger: true,
        typed: 'RESTORE LEDGER BOOK DATA',
      });
      if (!ok) return;
      try {
        await api('/api/restore', { method: 'POST', body: { confirm: 'RESTORE LEDGER BOOK DATA', backup } });
        toast('Backup restored.');
        await refreshAll();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  function listEditor(key, items) {
    const canEdit = isSuper();
    // Categories: Mid Users may add (not remove); accounts stay with Super Users.
    const canAdd = canEdit || (key === 'categories' && canManageLists());
    const locked = (v) => (key === 'accounts' && v === PETTY_CASH) || (key === 'categories' && v === 'Needs review');
    return `<div>${items
      .map((v) => `<span class="tag">${esc(v)}${locked(v) ? ' <span class="muted small">System</span>' : canEdit ? `<button data-rm-${key}="${esc(v)}" aria-label="Remove">×</button>` : ''}</span>`)
      .join('')}</div>
      ${canAdd ? `<div class="row" style="margin-top:12px;flex-wrap:nowrap"><input class="input" id="add-${key}" maxlength="80" placeholder="Add ${key === 'accounts' ? 'an account' : 'a category'}"><button class="btn" id="btn-${key}">${icon('plus')}Add</button></div>` : `<div class="small muted" style="margin-top:10px">${key === 'categories' ? 'New categories are added by Mid Users and Super Users.' : 'Managed by Super Users.'}</div>`}`;
  }
  function bindListEditor(el, key) {
    if (key === 'categories' && canManageLists()) {
      $(`#btn-${key}`, el).addEventListener('click', async () => {
        const name = $(`#add-${key}`, el).value.trim();
        if (!name) return;
        try {
          await api('/api/categories', { method: 'POST', body: { name } });
          toast(`Category “${name}” added.`);
          await refreshAll();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }
    if (!isSuper()) return;
    const save = async (list) => {
      try {
        await api('/api/settings', { method: 'PUT', body: { key, value: list } });
        await refreshAll();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    if (key !== 'categories')
      $(`#btn-${key}`, el).addEventListener('click', () => {
        const v = $(`#add-${key}`, el).value.trim();
        if (v) save([...S.data.settings[key], v]);
      });
    $$(`[data-rm-${key}]`, el).forEach((b) =>
      b.addEventListener('click', async () => {
        const v = b.getAttribute(`data-rm-${key}`);
        if (!(await confirmModal({ title: 'Remove', message: `Remove <b>${esc(v)}</b> from the list? Existing transactions keep it.`, confirmLabel: 'Remove', danger: true }))) return;
        save(S.data.settings[key].filter((x) => x !== v));
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Change password (also forced on first sign-in)
  // ---------------------------------------------------------------------------
  function openChangePassword(forced) {
    const m = openModal({
      title: forced ? 'Set your password' : 'Change password',
      dismissable: !forced,
      body: `${forced ? `<div class="alert info">${icon('lock')}<span>You signed in with a temporary password. Choose your own password to continue.</span></div>` : ''}
        <label class="field"><span>Current password</span><input class="input" type="password" id="cp-cur" autocomplete="current-password"></label>
        <label class="field"><span>New password</span><input class="input" type="password" id="cp-new" autocomplete="new-password"></label>
        <label class="field"><span>Confirm new password</span><input class="input" type="password" id="cp-new2" autocomplete="new-password"></label>
        <div class="small muted">At least 8 characters, with letters and numbers.</div>`,
      footer: `${forced ? '<button class="btn" data-act="logout">Sign out</button>' : '<button class="btn" data-close>Cancel</button>'}<button class="btn primary" id="cp-ok">Update password</button>`,
    });
    $('#cp-ok', m.el).addEventListener('click', (e) =>
      withBusy(e.currentTarget, async () => {
        if ($('#cp-new', m.el).value !== $('#cp-new2', m.el).value) throw new Error('The new passwords do not match.');
        await api('/api/change-password', { method: 'POST', body: { current: $('#cp-cur', m.el).value, next: $('#cp-new', m.el).value } });
        m.close();
        toast('Password updated.');
        if (forced) await refreshAll();
        else await loadMe();
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Print / Ledger Statement
  // ---------------------------------------------------------------------------
  function openStatementDialog() {
    const accounts = S.data.settings.accounts;
    const [a, b] = periodRange(S.period);
    const m = openModal({
      title: 'Print ledger statement',
      body: `<div class="grid-2">
          <label class="field"><span>Account</span><select class="input" id="st-acc"><option value="">All accounts</option>${[...accounts, ...(S.data.loans.length ? [S.data.loanAccount] : [])].map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>
          <label class="field"><span>Tag</span><select class="input" id="st-tag"><option value="">All tags</option>${S.data.tags.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>
        </div>
        <label class="field"><span>Date range</span><select class="input" id="st-preset">${PERIODS.map(([v, l]) => `<option value="${v}"${v === S.period ? ' selected' : ''}>${v === 'all' ? 'All dates' : l}</option>`).join('')}</select></label>
        <div class="grid-2">
          <label class="field"><span>From</span><input class="input" type="date" id="st-from" value="${a || ''}"></label>
          <label class="field"><span>To</span><input class="input" type="date" id="st-to" value="${b || ''}"></label>
        </div>
        <div class="small muted">Leave From empty to start at the first entry, or To empty to run up to today. Only posted transactions appear. The statement opens in a new tab ready to print or save as PDF.</div>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="st-ok">${icon('print')}Generate statement</button>`,
    });
    // A preset fills the From/To pickers; editing a date switches to "Custom range".
    $('#st-preset', m.el).addEventListener('change', (e) => {
      if (e.target.value === 'custom') return;
      const [pa, pb] = periodRange(e.target.value);
      $('#st-from', m.el).value = pa || '';
      $('#st-to', m.el).value = pb || '';
    });
    ['#st-from', '#st-to'].forEach((sel) => $(sel, m.el).addEventListener('change', () => ($('#st-preset', m.el).value = 'custom')));
    $('#st-ok', m.el).addEventListener('click', () => {
      const from = $('#st-from', m.el).value || null;
      const to = $('#st-to', m.el).value || null;
      if (from && to && from > to) return toast('The From date is after the To date.', 'error');
      const win = window.open('', '_blank');
      if (!win) return toast('Please allow pop-ups for this site to print the statement.', 'error');
      win.document.write(statementHtml($('#st-acc', m.el).value, from, to, $('#st-tag', m.el).value));
      win.document.close();
      m.close();
    });
  }

  function statementHtml(account, from, to, tag = '') {
    const dmy = (iso) => iso.split('-').reverse().join('-');
    // Running/opening/closing balances only make sense for a whole account,
    // not for a tag's subset of it.
    const balances = !!account && !tag;
    const rows = [];
    for (const t of postedTx()) {
      if ((from && t.dateISO < from) || (to && t.dateISO > to)) continue;
      if (tag && !t.tags.includes(tag)) continue;
      if (isLoan(t) && account !== S.data.loanAccount) {
        const cash = loanCashAccount(t);
        if (!account || cash === account)
          rows.push({ t, debit: t.kind === 'loan_given' ? t.amount : 0, credit: t.kind === 'loan_recovery' ? t.amount : 0, acct: cash, desc: t.description });
      } else if (t.type === 'transfer') {
        if (!account || t.account === account) rows.push({ t, debit: t.amount, credit: 0, acct: t.account, desc: `${t.description} (to ${t.toAccount})` });
        if (!account || t.toAccount === account) rows.push({ t, debit: 0, credit: t.amount, acct: t.toAccount, desc: `${t.description} (from ${t.account})` });
      } else if (!account || t.account === account) {
        rows.push({ t, debit: t.type === 'expense' ? t.amount : 0, credit: t.type === 'receive' ? t.amount : 0, acct: t.account, desc: t.description });
      }
    }
    rows.sort((x, y) => (x.t.dateISO < y.t.dateISO ? -1 : x.t.dateISO > y.t.dateISO ? 1 : x.t.voucherNo < y.t.voucherNo ? -1 : 1));
    // Opening balance for a single-account statement
    let opening = 0;
    if (balances && from) for (const t of postedTx()) if (t.dateISO < from) opening += signedAmount(t, account);
    const credit = rows.reduce((s, r) => s + r.credit, 0);
    const debit = rows.reduce((s, r) => s + r.debit, 0);
    let run = opening;
    const cats = new Map();
    for (const r of rows) {
      const c = r.t.type === 'transfer' && !isLoan(r.t) ? 'Transfer' : r.t.category;
      cats.set(c, (cats.get(c) || 0) + (r.credit - r.debit));
    }
    const m = (n) => money(n);
    const period = `${from ? dmy(from) : 'Beginning'} to ${to ? dmy(to) : dmy(isoLocal(new Date()))}`;
    const body = rows
      .map((r) => {
        run += r.credit - r.debit;
        return `<tr><td>${esc(r.t.date)}</td><td>${esc(r.t.voucherNo)}</td><td>${esc(r.desc)}${!account ? `<div class="s">${esc(r.acct)}</div>` : ''}</td><td>${esc(r.t.type === 'transfer' && !isLoan(r.t) ? 'Transfer' : r.t.category)}</td>
          <td class="n">${r.debit ? m(r.debit) : ''}</td><td class="n">${r.credit ? m(r.credit) : ''}</td>${balances ? `<td class="n">${m(run)}</td>` : ''}</tr>`;
      })
      .join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Ledger Statement — ${esc(S.company)}</title>
      <style>
        body{font:12px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1b1a2b;margin:28px}
        .head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #171735;padding-bottom:12px}
        h1{font-size:24px;margin:0;letter-spacing:.02em} h2{font-size:15px;margin:2px 0 0;color:#6558d3;font-weight:600}
        .meta{text-align:right;color:#55536b}
        .boxes{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:10px;margin:16px 0}
        .box{border:1px solid #d9d8e5;border-radius:8px;padding:9px 11px}.box b{display:block;font-size:14px;margin-top:3px}
        .box span{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#6b6985}
        table{width:100%;border-collapse:collapse}th{background:#171735;color:#fff;text-align:left;padding:7px 8px;font-size:11px}
        td{padding:6px 8px;border-bottom:1px solid #e6e5ef;vertical-align:top}.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
        tfoot td{font-weight:700;border-top:2px solid #171735}.s{color:#8a88a0;font-size:10.5px}
        .cats{margin-top:18px;padding-top:10px;border-top:1px solid #d9d8e5;line-height:1.9}
        .cats b{font-size:12px}.sig{display:grid;grid-template-columns:repeat(3,1fr);gap:40px;margin-top:60px}
        .sig div{border-top:1px solid #1b1a2b;padding-top:6px;text-align:center;color:#55536b}
        .foot{margin-top:24px;color:#8a88a0;font-size:10.5px;text-align:center}
        @media print{body{margin:12mm}.noprint{display:none}}
      </style></head><body>
      <div class="head"><div><h1>${esc(S.company)}</h1><h2>Ledger Statement</h2></div>
        <div class="meta"><div><b>Account:</b> ${esc(account || 'All accounts')}</div>${tag ? `<div><b>Tag:</b> ${esc(tag)}</div>` : ''}<div><b>Period:</b> ${esc(period)}</div><div>Generated ${esc(fmtDateTime(new Date().toISOString()))} by ${esc(S.me.fullName)}</div></div></div>
      <div class="boxes">
        ${balances ? `<div class="box"><span>Opening balance</span><b>${m(opening)}</b></div>` : ''}
        <div class="box"><span>Total credit</span><b>${m(credit)}</b></div>
        <div class="box"><span>Total debit</span><b>${m(debit)}</b></div>
        <div class="box"><span>Net</span><b>${m(credit - debit)}</b></div>
        <div class="box"><span>Petty Cash balance</span><b>${m(S.data.pettyCash)}</b></div>
        ${balances ? `<div class="box"><span>Closing balance</span><b>${m(run)}</b></div>` : ''}
      </div>
      <table><thead><tr><th>Date</th><th>Voucher</th><th>Description</th><th>Category</th><th class="n">Debit</th><th class="n">Credit</th>${balances ? '<th class="n">Balance</th>' : ''}</tr></thead>
        <tbody>${body || `<tr><td colspan="${balances ? 7 : 6}" style="text-align:center;padding:20px;color:#8a88a0">No posted transactions in this period.</td></tr>`}</tbody>
        <tfoot><tr><td colspan="4">Totals · ${rows.length} entries</td><td class="n">${m(debit)}</td><td class="n">${m(credit)}</td>${balances ? `<td class="n">${m(run)}</td>` : ''}</tr></tfoot></table>
      <div class="cats"><b>Summary by category:</b>&nbsp; ${[...cats.entries()].map(([c, v]) => `${esc(c)} : ${m(v)}`).join('&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;') || '—'}</div>
      <div class="sig"><div>Prepared by</div><div>Checked by</div><div>Approved by</div></div>
      <div class="foot">${esc(S.company)} · Ledger Book · Computer-generated statement of posted transactions</div>
      <script>window.onload=function(){setTimeout(function(){window.print()},300)}<\/script>
      </body></html>`;
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  function applyTheme() {
    const t = store.get('theme', 'system');
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }

  async function boot() {
    applyTheme();
    try {
      await loadMe();
      await loadState();
    } catch (err) {
      $('#root').innerHTML = `<div class="boot"><div style="text-align:center"><p>Could not load the Ledger Book: ${esc(err.message)}</p><button class="btn" onclick="location.reload()">Retry</button></div></div>`;
      return;
    }
    renderShell();
    window.addEventListener('hashchange', route);
    if (S.me.mustChangePassword) {
      $('#page-title').textContent = 'Welcome';
      $('#content').innerHTML = '';
      openChangePassword(true);
    } else await route();
    startPolling();
    pushSync();
  }

  boot();
})();
