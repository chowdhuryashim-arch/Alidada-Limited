/* Show / hide toggle for every password field (sign-in, setup, change password).
   Watches the page so fields inside dialogs opened later are covered too. */
(() => {
  'use strict';
  const EYE = '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
  const EYE_OFF =
    '<path d="M9.9 4.2A9.8 9.8 0 0 1 12 4c6.5 0 10 8 10 8a17 17 0 0 1-2.2 3.3M6.6 6.6C3.7 8.4 2 12 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.4-1.6"/><path d="M14.1 14.1a3 3 0 0 1-4.2-4.2"/><path d="M2 2l20 20"/>';
  const svg = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;

  const style = document.createElement('style');
  style.textContent = `
    .pw-wrap { position: relative; display: block; width: 100%; }
    .pw-wrap > input { width: 100%; padding-right: 46px !important; }
    .pw-wrap > input::-ms-reveal, .pw-wrap > input::-ms-clear { display: none; }
    .pw-wrap > button.pw-eye {
      position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
      width: 34px; height: 34px; margin: 0; padding: 0; border: 0; border-radius: 8px;
      background: transparent; color: var(--ink-3, #8a88a0); cursor: pointer;
      display: grid; place-items: center;
    }
    .pw-wrap > button.pw-eye:hover { color: var(--accent, #6558d3); background: rgba(101, 88, 211, 0.1); }
    .pw-wrap > button.pw-eye:focus-visible { outline: 2px solid var(--accent, #6558d3); outline-offset: 1px; }
    .pw-wrap > button.pw-eye svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  `;
  document.head.appendChild(style);

  function enhance(input) {
    if (input.dataset.pwToggle) return;
    input.dataset.pwToggle = '1';
    const wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-eye';
    const render = () => {
      const shown = input.type === 'text';
      btn.innerHTML = svg(shown ? EYE_OFF : EYE);
      btn.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
      btn.setAttribute('aria-pressed', String(shown));
      btn.title = shown ? 'Hide password' : 'Show password';
    };
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the field
    btn.addEventListener('click', () => {
      const pos = input.selectionStart;
      input.type = input.type === 'password' ? 'text' : 'password';
      render();
      input.focus();
      try {
        input.setSelectionRange(pos, pos);
      } catch {
        /* some input types do not support selection */
      }
    });
    render();
    wrap.appendChild(btn);
  }

  const scan = (root) => {
    if (root.matches && root.matches('input[type="password"]')) enhance(root);
    if (root.querySelectorAll) root.querySelectorAll('input[type="password"]').forEach(enhance);
  };
  const start = () => {
    scan(document.body);
    new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach(scan))).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
