'use strict';

const root = document.querySelector('#app');

let state = null;
let activeView = 'inbox';
let editingContact = null;
let addressBook = [];
let directDraft = null;
// What the owner is writing right now, measured as he writes. This is the same
// reading that decides whether a sent message is worth learning from.
const liveChecks = new Map();
let checkTimer = null;
let busy = '';

// Text the owner is in the middle of typing. The main process broadcasts on every
// incoming message, so without this a re-render would wipe a half-written reply.
const drafts = new Map();
const mediaCache = new Map();

/* ------------------------------------------------------------------- helpers */

function language() {
  const chosen = state.settings.forcedLanguage || state.settings.language;
  if (chosen.startsWith('pt')) return 'pt-BR';
  if (chosen.startsWith('en')) return 'en';
  return navigator.language.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
}

function t(key) {
  return window.TRANSLATIONS[language()][key] ?? key;
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function draftValue(key, fallback = '') {
  return drafts.has(key) ? drafts.get(key) : fallback;
}

function initialOf(value) {
  const letter = String(value || '').trim()[0];
  return letter ? letter.toUpperCase() : '?';
}

function timeOf(value) {
  return new Date(value).toLocaleTimeString(language(), { hour: '2-digit', minute: '2-digit' });
}

function applyPlatform() {
  document.documentElement.dataset.platform = window.desvio.platform;
}

function applyTheme() {
  const chosen = state.settings.theme;
  const theme =
    chosen === 'system'
      ? matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : chosen;
  document.documentElement.dataset.theme = theme;
}

function statusLabel() {
  return (
    {
      ready: t('stateReady'),
      connecting: t('stateConnecting'),
      authenticating: t('stateConnecting'),
      scan_qr: t('stateScan'),
      error: t('stateError')
    }[state.connection] ?? t('stateOffline')
  );
}

/* -------------------------------------------------------------------- pieces */

function topbar() {
  return `
    <header class="topbar">
      <div class="brand"><span class="mark">↗</span><span>desvio</span></div>
      <div class="status">
        <i class="${state.connection === 'ready' ? 'ready' : ''}"></i>${escapeHtml(statusLabel())}
      </div>
    </header>`;
}

function sidebar() {
  const items = [
    ['inbox', '⌂'],
    ['people', '◎'],
    ['settings', '⚙']
  ];
  const nav = items
    .map(
      ([view, icon]) => `
        <button class="nav-item ${activeView === view ? 'active' : ''}" data-view="${view}">
          <span>${icon}</span>${escapeHtml(t(view))}
        </button>`
    )
    .join('');
  return `<aside class="sidebar"><nav>${nav}</nav><p class="sidebar-foot">${escapeHtml(
    t('privacyLine')
  )}</p></aside>`;
}

function needsYouTag(item) {
  if (!item.needsOwner) return '';
  const why = item.needsOwnerReason ? ` title="${escapeHtml(item.needsOwnerReason)}"` : '';
  return `<span class="tag needs-you"${why}>${escapeHtml(t('needsYou'))}</span>`;
}

function importanceTag(item) {
  if (item.importance !== 'important') return '';
  const title = item.reason ? ` title="${escapeHtml(item.reason)}"` : '';
  return `<span class="tag important"${title}>${escapeHtml(t('important'))}</span>`;
}

function aiTag(item) {
  const ai = item.ai;
  if (!ai || ai.level === 'none') return '';
  const label = {
    certain: t('aiCertain'),
    high: t('aiHigh'),
    medium: t('aiMedium'),
    low: t('aiLow')
  }[ai.level];
  const why = ai.signals.map((signal) => t(signal.id)).join(' · ');
  return `<span class="tag ai ai-${ai.level}" title="${escapeHtml(
    `${t('aiWhy')}: ${why}`
  )}">${escapeHtml(label)} · ${ai.score}%</span>`;
}

function mediaBlock(item) {
  const pieces = [];
  if (item.hasMedia) {
    const cached = mediaCache.get(item.id);
    if (cached === 'loading') {
      pieces.push(`<p class="media-note">${escapeHtml(t('loadingMedia'))}</p>`);
    } else if (cached === 'error') {
      pieces.push(`<p class="media-note">${escapeHtml(t('mediaFailed'))}</p>`);
    } else if (cached) {
      const url = escapeHtml(cached.url);
      if (cached.kind === 'video') {
        pieces.push(
          `<video class="media-preview" controls preload="metadata" src="${url}"></video>`
        );
      } else if (cached.kind === 'audio') {
        pieces.push(`<audio class="media-audio" controls preload="metadata" src="${url}"></audio>`);
      } else {
        pieces.push(`<img class="media-preview" src="${url}" alt="${escapeHtml(item.name)}" />`);
      }
    } else {
      pieces.push(
        `<button class="media-link" data-load-media="${escapeHtml(item.id)}">${escapeHtml(
          t('viewMedia')
        )}</button>`
      );
    }
  }
  if (item.externalUrl) {
    pieces.push(
      `<button class="media-link" data-open-link="${escapeHtml(item.externalUrl)}">${escapeHtml(
        t('openLink')
      )} ↗</button>`
    );
  }
  return pieces.length ? `<div class="media-wrap">${pieces.join('')}</div>` : '';
}

function aiMeter(key) {
  const result = liveChecks.get(key);
  if (result === undefined) {
    return `<div class="ai-meter" data-ai-meter="${escapeHtml(key)}">${escapeHtml(
      t('aiChecking')
    )}</div>`;
  }
  if (!result || result.level === 'none') {
    return `<div class="ai-meter clean" data-ai-meter="${escapeHtml(key)}">
      <span class="dot"></span>${escapeHtml(t('aiClean'))}
    </div>`;
  }
  const label = {
    certain: t('aiCertain'),
    high: t('aiHigh'),
    medium: t('aiMedium'),
    low: t('aiLow')
  }[result.level];
  const why = result.signals.map((signal) => t(signal.id)).join(' · ');
  return `<div class="ai-meter ai-${result.level}" data-ai-meter="${escapeHtml(key)}">
    <span class="dot"></span><b>${escapeHtml(label)} · ${result.score}%</b>
    <small>${escapeHtml(why)}</small>
  </div>`;
}

// Measuring on every keystroke would be wasteful and jumpy; a short pause after
// typing stops is the moment the reading is useful.
function scheduleCheck(key, text) {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(async () => {
    const result = await window.desvio.inspectText(text);
    liveChecks.set(key, result);
    const node = document.querySelector(`[data-ai-meter="${CSS.escape(key)}"]`);
    if (node) node.outerHTML = aiMeter(key);
  }, 220);
}

// Meters render from cache; anything not measured yet asks once, without blocking
// the paint.
function fillPendingMeters() {
  document.querySelectorAll('[data-ai-meter]').forEach((node) => {
    const key = node.dataset.aiMeter;
    if (liveChecks.has(key)) return;
    const field = document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
    if (!field) return;
    window.desvio.inspectText(field.value).then((result) => {
      liveChecks.set(key, result);
      const target = document.querySelector(`[data-ai-meter="${CSS.escape(key)}"]`);
      if (target) target.outerHTML = aiMeter(key);
    });
  });
}

function replyCard(item) {
  const key = `reply:${item.id}`;
  return `
    <article class="reply-card">
      <div class="reply-meta">
        <div><b>${escapeHtml(item.name)}</b>${needsYouTag(item)}${importanceTag(item)}${aiTag(item)}</div>
        <time>${escapeHtml(timeOf(item.receivedAt))}</time>
      </div>
      ${item.body ? `<p class="incoming">${escapeHtml(item.body)}</p>` : ''}
      ${mediaBlock(item)}
      <label>${escapeHtml(t('suggestion'))}
        <textarea data-focus-key="${key}">${escapeHtml(draftValue(key, item.reply))}</textarea>
      </label>
      ${aiMeter(key)}
      <div class="actions">
        <button class="text-button" data-dismiss="${escapeHtml(item.id)}">${escapeHtml(
          t('dismiss')
        )}</button>
        <button class="primary" data-send="${escapeHtml(item.id)}">${escapeHtml(t('send'))}</button>
      </div>
    </article>`;
}

function recentRow(item) {
  const preview = item.body || (item.hasMedia ? `· ${item.mediaKind} ·` : '');
  return `
    <li>
      <div>
        <b>${escapeHtml(item.name)}</b>
        <span>${escapeHtml(preview)}</span>
      </div>
      <div class="recent-tags">${item.sent ? `<span class="tag">${escapeHtml(t('sentAuto'))}</span>` : ''}${needsYouTag(item)}${aiTag(
        item
      )}${importanceTag(item)}</div>
    </li>`;
}

function hero() {
  if (state.connection === 'scan_qr' && state.qr) {
    return `
      <section class="hero qr">
        <div>
          <p class="eyebrow">WHATSAPP</p>
          <h1>${escapeHtml(t('scanTitle'))}</h1>
          <p>${escapeHtml(t('scanText'))}</p>
        </div>
        <img src="${escapeHtml(state.qr)}" alt="QR" />
      </section>`;
  }
  if (state.connection === 'ready') {
    return `
      <section class="hero">
        <p class="eyebrow">WHATSAPP</p>
        <h1>${escapeHtml(t('readyTitle'))}</h1>
        <p>${escapeHtml(t('readyText'))}</p>
        <button class="quiet" data-disconnect>${escapeHtml(t('disconnect'))}</button>
      </section>`;
  }
  const working = state.connection === 'connecting' || state.connection === 'authenticating';
  return `
    <section class="hero">
      <p class="eyebrow">WHATSAPP</p>
      <h1>${escapeHtml(working ? t('connectingTitle') : t('scanTitle'))}</h1>
      <p>${escapeHtml(working ? t('connectingText') : t('scanText'))}</p>
      ${working ? '' : `<button class="primary" data-connect>${escapeHtml(t('connect'))}</button>`}
    </section>`;
}

function directCard() {
  const available = state.settings.contacts.filter(
    (contact) => contact.enabled !== false && contact.mode !== 'disabled'
  );
  if (!available.length) {
    return `<section class="direct-card"><p class="eyebrow">${escapeHtml(
      t('directTitle')
    )}</p><p class="direct-copy">${escapeHtml(t('directEmpty'))}</p></section>`;
  }
  const options = available
    .map(
      (contact) =>
        `<option value="${escapeHtml(contact.id)}" ${
          directDraft?.id === contact.id ? 'selected' : ''
        }>${escapeHtml(contact.name)}</option>`
    )
    .join('');
  const result = directDraft?.reply
    ? `<div class="direct-result">
        ${directDraft.aiLike ? `<span class="tag ai ai-medium">${escapeHtml(t('aiLikeFixed'))}</span>` : ''}
        <textarea data-focus-key="direct:reply">${escapeHtml(
          draftValue('direct:reply', directDraft.reply)
        )}</textarea>
        ${aiMeter('direct:reply')}
        <button class="primary" data-send-direct="${escapeHtml(directDraft.id)}">${escapeHtml(
          t('send')
        )}</button>
      </div>`
    : '';
  return `
    <section class="direct-card">
      <p class="eyebrow">${escapeHtml(t('directTitle'))}</p>
      <p class="direct-copy">${escapeHtml(t('directHint'))}</p>
      <form id="direct-form">
        <select name="id">${options}</select>
        <textarea name="instruction" data-focus-key="direct:instruction" placeholder="${escapeHtml(
          t('directPlaceholder')
        )}">${escapeHtml(draftValue('direct:instruction'))}</textarea>
        <button class="primary" type="submit" ${busy === 'direct' ? 'disabled' : ''}>${escapeHtml(
          busy === 'direct' ? t('creating') : t('createMessage')
        )}</button>
      </form>
      ${result}
    </section>`;
}

function inboxView() {
  const pending = state.pending.map(replyCard).join('');
  const recent = state.recent.slice(0, 12).map(recentRow).join('');
  return `
    <section class="content">
      <div class="page-heading"><h1>${escapeHtml(t('inbox'))}</h1></div>
      ${hero()}
      <div class="section-title">
        <h2>${escapeHtml(t('pendingTitle'))}</h2>
        <span class="count">${state.pending.length}</span>
      </div>
      <div class="reply-list">
        ${
          pending ||
          `<div class="empty"><div class="empty-icon">↗</div><h2>${escapeHtml(
            t('emptyPendingTitle')
          )}</h2><p>${escapeHtml(t('emptyPendingText'))}</p></div>`
        }
      </div>
      <div class="section-title recent-title"><h2>${escapeHtml(t('recentTitle'))}</h2></div>
      <ul class="recent-list">${recent || `<li class="muted">${escapeHtml(t('emptyRecent'))}</li>`}</ul>
      ${directCard()}
    </section>`;
}

/* -------------------------------------------------------------------- people */

function contactForm(contact) {
  const taken = new Set(
    state.settings.contacts.filter((item) => item.id !== contact.id).map((item) => item.phone)
  );
  const options = addressBook
    .filter((entry) => !taken.has(entry.phone))
    .map(
      (entry) =>
        `<option value="${escapeHtml(entry.phone)}" ${
          entry.phone === contact.phone ? 'selected' : ''
        }>${escapeHtml(entry.name)} · +${escapeHtml(entry.phone)}</option>`
    )
    .join('');

  const body = options
    ? `
      <label>${escapeHtml(t('chooseContact'))}
        <select required name="phone">
          <option value="">${escapeHtml(t('chooseContact'))}</option>
          ${options}
        </select>
      </label>
      <label>${escapeHtml(t('mode'))}
        <select name="mode">
          <option value="disabled" ${contact.mode === 'disabled' ? 'selected' : ''}>${escapeHtml(
            t('modeDisabled')
          )}</option>
          <option value="approval" ${
            contact.mode === 'approval' ? 'selected' : ''
          }>${escapeHtml(t('modeAsk'))}</option>
          <option value="auto" ${
            !contact.mode || contact.mode === 'auto' ? 'selected' : ''
          }>${escapeHtml(t('modeAuto'))}</option>
        </select>
      </label>
      <label>${escapeHtml(t('styleForPerson'))}
        <textarea name="style" placeholder="${escapeHtml(state.settings.defaultStyle)}">${escapeHtml(
          contact.style || ''
        )}</textarea>
      </label>
      <label class="switch-row">
        <span>${escapeHtml(t('enabled'))}</span>
        <input type="checkbox" name="enabled" ${contact.enabled === false ? '' : 'checked'} /><i></i>
      </label>
      <button class="primary" type="submit">${escapeHtml(t('save'))}</button>
      ${
        contact.id
          ? `<button type="button" class="text-button danger" data-remove-contact="${escapeHtml(
              contact.id
            )}">${escapeHtml(t('removePerson'))}</button>`
          : ''
      }`
    : `<p class="hint">${escapeHtml(t('connectToChoose'))}</p>`;

  return `
    <form id="contact-form" class="form-sheet">
      <div class="sheet-head">
        <h2>${escapeHtml(contact.id ? t('editPerson') : t('addPerson'))}</h2>
        <button type="button" class="icon-button" data-close-form>×</button>
      </div>
      <input type="hidden" name="id" value="${escapeHtml(contact.id || crypto.randomUUID())}" />
      ${body}
    </form>`;
}

function peopleView() {
  const rows = state.settings.contacts
    .map((contact) => {
      const mode =
        contact.mode === 'auto'
          ? t('modeAuto')
          : contact.mode === 'disabled'
            ? t('modeDisabled')
            : t('modeAsk');
      return `
        <li class="person-row">
          <button data-edit-contact="${escapeHtml(contact.id)}" class="person-main">
            <span class="avatar">${escapeHtml(initialOf(contact.name || contact.phone))}</span>
            <span>
              <b>${escapeHtml(contact.name || contact.phone)}</b>
              <small>+${escapeHtml(contact.phone)} · ${escapeHtml(mode)}</small>
            </span>
          </button>
          <span class="toggle-dot ${contact.enabled === false ? '' : 'on'}"></span>
        </li>`;
    })
    .join('');

  return `
    <section class="content">
      <div class="page-heading">
        <div><h1>${escapeHtml(t('peopleTitle'))}</h1><p>${escapeHtml(t('peopleText'))}</p></div>
        <button class="primary" data-new-contact ${busy === 'contacts' ? 'disabled' : ''}>${escapeHtml(
          t('addPerson')
        )}</button>
      </div>
      <ul class="people-list">
        ${
          rows ||
          `<div class="empty"><div class="empty-icon">◎</div><h2>${escapeHtml(
            t('noPeopleTitle')
          )}</h2><p>${escapeHtml(t('noPeopleText'))}</p></div>`
        }
      </ul>
      ${editingContact ? contactForm(editingContact) : ''}
    </section>`;
}

/* ------------------------------------------------------------------ settings */

// Groq's catalogue changes under the app, so the choice is a list of what the key
// can actually reach today, not a name typed from memory.
function modelField(current) {
  const models = state.groqModels || [];
  if (!models.length) {
    return `<input name="model" value="${escapeHtml(current)}" />`;
  }
  const options = (models.includes(current) ? models : [current, ...models])
    .map(
      (id) =>
        `<option value="${escapeHtml(id)}" ${id === current ? 'selected' : ''}>${escapeHtml(
          id
        )}</option>`
    )
    .join('');
  return `<select name="model">${options}</select>`;
}

function settingsView() {
  const s = state.settings;
  const learning = state.learning;
  const importLabel =
    learning.status === 'importing'
      ? `${t('importing')} ${learning.chats}/${learning.chatsTotal}`
      : t('importNow');

  const historyOptions = [
    ['7d', 'week'],
    ['30d', 'month'],
    ['90d', 'quarter'],
    ['365d', 'year'],
    ['all', 'allHistory']
  ]
    .map(
      ([value, key]) =>
        `<option value="${value}" ${s.learning.historyWindow === value ? 'selected' : ''}>${escapeHtml(
          t(key)
        )}</option>`
    )
    .join('');

  const themeOptions = ['system', 'dark', 'light']
    .map(
      (theme) =>
        `<label><input type="radio" name="theme" value="${theme}" ${
          s.theme === theme ? 'checked' : ''
        } /><span>${escapeHtml(t(theme))}</span></label>`
    )
    .join('');

  return `
    <section class="content settings">
      <div class="page-heading">
        <div><h1>${escapeHtml(t('settingsTitle'))}</h1><p>${escapeHtml(t('privacyLine'))}</p></div>
      </div>
      <form id="settings-form">
        <section class="setting-group">
          <p class="eyebrow">${escapeHtml(t('groqSection'))}</p>
          <label>${escapeHtml(t('groqKey'))}
            <input name="groqApiKey" type="password" placeholder="gsk_…" value="" autocomplete="off" />
          </label>
          <p class="hint">${escapeHtml(s.groqConfigured ? t('groqSaved') : t('groqHint'))}</p>
          <label>${escapeHtml(t('model'))}${modelField(s.model)}</label>
          <label>${escapeHtml(t('defaultStyle'))}
            <textarea name="defaultStyle">${escapeHtml(s.defaultStyle)}</textarea>
          </label>
        </section>

        <section class="setting-group">
          <p class="eyebrow">${escapeHtml(t('learningSection'))}</p>
          <label class="switch-row">
            <span>${escapeHtml(t('learnEnabled'))}</span>
            <input type="checkbox" name="learningEnabled" ${
              s.learning.enabled ? 'checked' : ''
            } /><i></i>
          </label>
          <label>${escapeHtml(t('history'))}
            <select name="historyWindow">${historyOptions}</select>
          </label>
          <div class="inline-actions">
            <button type="button" class="quiet" data-import-history ${
              state.connection !== 'ready' || learning.status === 'importing' ? 'disabled' : ''
            }>${escapeHtml(importLabel)}</button>
            <button type="button" class="text-button" data-forget-samples>${escapeHtml(
              t('forgetSamples')
            )}</button>
            <span class="count">${s.sampleCount} ${escapeHtml(t('samplesStored'))}</span>
            ${
              learning.skipped
                ? `<span class="count muted-count">${learning.skipped} ${escapeHtml(
                    t('samplesSkipped')
                  )}</span>`
                : ''
            }
          </div>
          <p class="hint">${escapeHtml(t('learnHint'))}</p>
        </section>

        <section class="setting-group">
          <p class="eyebrow">${escapeHtml(t('alertsSection'))}</p>
          <label class="switch-row">
            <span>${escapeHtml(t('watchEveryone'))}</span>
            <input type="checkbox" name="watchEveryone" ${s.watchEveryone ? 'checked' : ''} /><i></i>
          </label>
          <p class="hint">${escapeHtml(t('watchHint'))}</p>
          <label class="switch-row">
            <span>${escapeHtml(t('webhookEnabled'))}</span>
            <input type="checkbox" name="webhookEnabled" ${
              s.webhook.enabled ? 'checked' : ''
            } /><i></i>
          </label>
          <label>${escapeHtml(t('webhookUrl'))}
            <input name="webhookUrl" type="url" value="${escapeHtml(
              s.webhook.url
            )}" placeholder="https://home.local/api/webhook/desvio" />
          </label>
          <label>${escapeHtml(t('webhookToken'))}${
            s.webhook.tokenConfigured ? ` · ${escapeHtml(t('tokenSaved'))}` : ''
          }
            <input name="webhookToken" type="password" value="" autocomplete="off" />
          </label>
          <p class="hint">${escapeHtml(t('webhookHint'))}</p>
        </section>

        <section class="setting-group">
          <p class="eyebrow">${escapeHtml(t('appearance'))}</p>
          <div class="segmented">${themeOptions}</div>
          <label>${escapeHtml(t('languageLabel'))}
            <select name="language">
              <option value="system" ${s.language === 'system' ? 'selected' : ''}>${escapeHtml(
                t('system')
              )}</option>
              <option value="pt-BR" ${s.language === 'pt-BR' ? 'selected' : ''}>Português</option>
              <option value="en" ${s.language === 'en' ? 'selected' : ''}>English</option>
            </select>
          </label>
        </section>

        <button class="primary save-settings" type="submit" ${
          busy === 'settings' ? 'disabled' : ''
        }>${escapeHtml(t('saveSettings'))}</button>
      </form>
    </section>`;
}

/* -------------------------------------------------------------------- render */

function captureFocus() {
  const element = document.activeElement;
  if (!element?.dataset?.focusKey) return null;
  return {
    key: element.dataset.focusKey,
    start: element.selectionStart,
    end: element.selectionEnd
  };
}

function restoreFocus(snapshot) {
  if (!snapshot) return;
  const element = document.querySelector(`[data-focus-key="${CSS.escape(snapshot.key)}"]`);
  if (!element) return;
  element.focus();
  try {
    element.setSelectionRange(snapshot.start, snapshot.end);
  } catch {
    /* selection is not available on every input type */
  }
}

function currentView() {
  if (activeView === 'people') return peopleView();
  if (activeView === 'settings') return settingsView();
  return inboxView();
}

function render() {
  if (!state) return;
  applyPlatform();
  applyTheme();
  const focus = captureFocus();
  root.innerHTML = `
    ${topbar()}
    <div class="shell">${sidebar()}${currentView()}</div>
    ${
      state.error
        ? `<div class="toast"><span>${escapeHtml(
            state.error
          )}</span><button class="icon-button" data-clear-error>×</button></div>`
        : ''
    }`;
  bind();
  restoreFocus(focus);
  fillPendingMeters();
}

/* ------------------------------------------------------------------- actions */

async function run(name, action) {
  busy = name;
  render();
  try {
    await action();
  } catch (error) {
    state.error = error?.message || String(error);
  }
  busy = '';
  render();
}

async function loadMedia(id) {
  mediaCache.set(id, 'loading');
  render();
  try {
    mediaCache.set(id, await window.desvio.loadMedia(id));
  } catch {
    mediaCache.set(id, 'error');
  }
  render();
}

function collectContact(form) {
  const data = new FormData(form);
  const phone = String(data.get('phone') || '');
  const picked = addressBook.find((entry) => entry.phone === phone);
  return {
    id: String(data.get('id')),
    phone,
    waId: picked?.waId || '',
    name: picked?.name || phone,
    mode: String(data.get('mode') || 'approval'),
    style: String(data.get('style') || ''),
    enabled: data.get('enabled') === 'on'
  };
}

// #app itself survives every render, so this listener is attached once.
root.addEventListener('input', (event) => {
  const key = event.target?.dataset?.focusKey;
  if (!key) return;
  drafts.set(key, event.target.value);
  if (key.startsWith('reply:') || key === 'direct:reply') scheduleCheck(key, event.target.value);
});

function bind() {
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.onclick = () => {
      activeView = button.dataset.view;
      editingContact = null;
      render();
    };
  });

  document.querySelector('[data-clear-error]')?.addEventListener('click', () => {
    window.desvio.clearError();
  });
  document
    .querySelector('[data-connect]')
    ?.addEventListener('click', () => window.desvio.connect());
  document
    .querySelector('[data-disconnect]')
    ?.addEventListener('click', () => window.desvio.disconnect());

  document.querySelectorAll('[data-send]').forEach((button) => {
    button.onclick = () => {
      const id = button.dataset.send;
      const key = `reply:${id}`;
      const text = document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)?.value ?? '';
      drafts.delete(key);
      liveChecks.delete(key);
      run('send', () => window.desvio.decide(id, 'send', text));
    };
  });
  document.querySelectorAll('[data-dismiss]').forEach((button) => {
    button.onclick = () => {
      drafts.delete(`reply:${button.dataset.dismiss}`);
      liveChecks.delete(`reply:${button.dataset.dismiss}`);
      run('dismiss', () => window.desvio.decide(button.dataset.dismiss, 'dismiss'));
    };
  });

  document.querySelectorAll('[data-load-media]').forEach((button) => {
    button.onclick = () => loadMedia(button.dataset.loadMedia);
  });
  document.querySelectorAll('[data-open-link]').forEach((button) => {
    button.onclick = () => window.desvio.openLink(button.dataset.openLink);
  });

  document.querySelector('#direct-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const instruction = String(data.get('instruction') || '').trim();
    if (!instruction) return;
    const id = String(data.get('id'));
    run('direct', async () => {
      const result = await window.desvio.draftDirect(id, instruction);
      drafts.delete('direct:reply');
      liveChecks.delete('direct:reply');
      directDraft = { id, ...result };
    });
  });

  document.querySelector('[data-send-direct]')?.addEventListener('click', (event) => {
    const id = event.currentTarget.dataset.sendDirect;
    const text = document.querySelector('[data-focus-key="direct:reply"]')?.value ?? '';
    run('direct', async () => {
      await window.desvio.sendDirect(id, text);
      directDraft = null;
      drafts.delete('direct:reply');
      drafts.delete('direct:instruction');
      liveChecks.delete('direct:reply');
    });
  });

  document.querySelector('[data-new-contact]')?.addEventListener('click', () => {
    run('contacts', async () => {
      addressBook = await window.desvio.getContacts();
      editingContact = { mode: 'auto' };
    });
  });
  document.querySelectorAll('[data-edit-contact]').forEach((button) => {
    button.onclick = () => {
      run('contacts', async () => {
        addressBook = await window.desvio.getContacts();
        editingContact = state.settings.contacts.find(
          (contact) => contact.id === button.dataset.editContact
        );
      });
    };
  });
  document.querySelector('[data-close-form]')?.addEventListener('click', () => {
    editingContact = null;
    render();
  });
  document.querySelector('[data-remove-contact]')?.addEventListener('click', (event) => {
    const id = event.currentTarget.dataset.removeContact;
    run('contacts', async () => {
      const contacts = state.settings.contacts.filter((contact) => contact.id !== id);
      state = await window.desvio.saveSettings({ ...state.settings, contacts });
      editingContact = null;
    });
  });

  document.querySelector('#contact-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const contact = collectContact(event.currentTarget);
    run('contacts', async () => {
      const contacts = [
        ...state.settings.contacts.filter((item) => item.id !== contact.id),
        contact
      ];
      state = await window.desvio.saveSettings({ ...state.settings, contacts });
      editingContact = null;
    });
  });

  document.querySelector('[data-import-history]')?.addEventListener('click', () => {
    window.desvio.importHistory();
  });
  document.querySelector('[data-forget-samples]')?.addEventListener('click', () => {
    run('settings', async () => {
      state = await window.desvio.forgetSamples();
    });
  });

  document.querySelector('#settings-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = {
      ...state.settings,
      model: String(data.get('model') || ''),
      defaultStyle: String(data.get('defaultStyle') || ''),
      theme: String(data.get('theme') || 'system'),
      language: String(data.get('language') || 'system'),
      watchEveryone: data.get('watchEveryone') === 'on',
      learning: {
        ...state.settings.learning,
        enabled: data.get('learningEnabled') === 'on',
        historyWindow: String(data.get('historyWindow') || '7d')
      },
      webhook: {
        enabled: data.get('webhookEnabled') === 'on',
        url: String(data.get('webhookUrl') || ''),
        token: String(data.get('webhookToken') || '')
      }
    };
    const key = String(data.get('groqApiKey') || '');
    if (key) next.groqApiKey = key;
    run('settings', async () => {
      state = await window.desvio.saveSettings(next);
    });
  });
}

/* --------------------------------------------------------------------- start */

window.desvio.onState((next) => {
  state = next;
  render();
});
window.desvio.getState().then((next) => {
  state = next;
  render();
});
