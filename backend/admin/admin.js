// Lunex admin panel: a page of its own on the API's origin. Signs in the way the app does
// (email code or Telegram) with `admin: true`, so only administrators get a session; then talks
// to /v1/admin. No build step and no dependencies: plain DOM, no HTML built from data.

const API = '/v1';
const REFRESH_KEY = 'lunex.admin.refresh';
const DEVICE_KEY = 'lunex.admin.device';

// ---------- Small DOM helper ----------

/** h('div', { class: 'card', onclick }, 'text', child) — text is always text, never HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'value') el.value = value;
    else if (key === 'checked') el.checked = Boolean(value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const app = document.getElementById('app');
const number = new Intl.NumberFormat('ru-RU');
const fmt = (value) => number.format(Number(value ?? 0));
const dateTime = (value) =>
  value
    ? new Date(value).toLocaleString('ru-RU', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
const day = (value) =>
  value ? new Date(value).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';

function toast(message, error = false) {
  const el = h('div', { class: error ? 'toast error' : 'toast', role: 'status' }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

/** Asks before an action; `run` returns the message for the toast. */
function confirmAction({ title, body, action, danger = false, run }) {
  const dialog = h('dialog', { 'aria-labelledby': 'confirm-title' },
    h('h2', { id: 'confirm-title' }, title),
    body,
    h('div', { class: 'row', style: 'justify-content:flex-end' },
      h('button', { class: 'secondary', onclick: () => dialog.close() }, 'Отмена'),
      h('button', { class: danger ? 'danger' : '', onclick: async (event) => {
        event.target.disabled = true;
        try {
          const done = await run();
          dialog.close();
          toast(done);
        } catch (error) {
          toast(error.message, true);
          event.target.disabled = false;
        }
      } }, action)));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

// ---------- Session ----------

let accessToken = null;
let me = null;

function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

const device = () => ({
  id: deviceId(),
  platform: 'web',
  model: navigator.userAgent.slice(0, 64),
});

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.code;
    this.body = body;
  }
}

async function request(method, path, body, retry = true) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const response = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 && retry && (await refresh())) {
    return request(method, path, body, false);
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    if (response.status === 401) signOutLocally();
    throw new ApiError(response.status, data);
  }
  return data;
}

async function refresh() {
  const token = sessionStorage.getItem(REFRESH_KEY);
  if (!token) return false;
  const response = await fetch(`${API}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: token }),
  });
  if (!response.ok) {
    sessionStorage.removeItem(REFRESH_KEY);
    return false;
  }
  keep(await response.json());
  return true;
}

function keep(tokens) {
  accessToken = tokens.accessToken;
  sessionStorage.setItem(REFRESH_KEY, tokens.refreshToken);
}

function signOutLocally() {
  accessToken = null;
  me = null;
  sessionStorage.removeItem(REFRESH_KEY);
}

async function signOut() {
  const token = sessionStorage.getItem(REFRESH_KEY);
  if (token) {
    await fetch(`${API}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: token }),
    }).catch(() => {});
  }
  signOutLocally();
  renderLogin();
}

/** After a sign-in answered: the panel opens only for an administrator. */
async function signedIn(response) {
  keep(response);
  try {
    me = await request('GET', '/admin/me');
    route();
  } catch (error) {
    await signOut();
    renderLogin(error.code === 'admin_only' ? 'Этот аккаунт не администратор.' : error.message);
  }
}

// ---------- Sign-in ----------

async function renderLogin(message) {
  app.replaceChildren(
    h('div', { class: 'login' }, h('div', { class: 'card' }, h('div', { class: 'brand' }, 'Lunex', h('span', {}, 'админка')), h('p', { class: 'muted' }, 'Загрузка…'))),
  );
  let providers = { email: false, telegram: false };
  try {
    providers = await request('GET', '/auth/providers', undefined, false);
  } catch {
    // Shown below as «no method».
  }
  const card = h('div', { class: 'card' }, h('div', { class: 'brand' }, 'Lunex', h('span', {}, 'админка')));
  card.append(h('p', { class: 'muted' }, 'Вход только для администраторов.'));
  if (message) card.append(h('p', { class: 'negative small', role: 'alert' }, message));

  if (providers.email) {
    const email = h('input', { type: 'email', placeholder: 'Почта', autocomplete: 'email', required: true });
    const code = h('input', { inputmode: 'numeric', placeholder: 'Код из письма', maxlength: '6', hidden: true });
    const send = h('button', { type: 'submit' }, 'Получить код');
    let sent = false;
    const form = h('form', { class: 'stack', onsubmit: async (event) => {
      event.preventDefault();
      send.disabled = true;
      try {
        if (!sent) {
          await request('POST', '/auth/email/start', { email: email.value, language: 'ru' }, false);
          sent = true;
          code.hidden = false;
          email.disabled = true;
          send.textContent = 'Войти';
          code.focus();
        } else {
          const response = await request('POST', '/auth/email/verify', {
            email: email.value,
            code: code.value.trim(),
            device: device(),
            admin: true,
          }, false);
          await signedIn(response);
        }
      } catch (error) {
        renderLogin(error.code === 'admin_only' ? 'Этот аккаунт не администратор.' : error.message);
      } finally {
        send.disabled = false;
      }
    } }, email, code, send);
    card.append(form);
  }
  if (providers.telegram) {
    if (providers.email) card.append(h('div', { class: 'divider' }, 'или'));
    card.append(h('button', { class: 'secondary', onclick: () => location.assign(`${API}/auth/telegram/start?to=admin`) }, 'Войти через Telegram'));
  }
  if (!providers.email && !providers.telegram) {
    card.append(h('p', { class: 'small muted' }, 'На сервере не включён вход по почте или через Telegram — веб-панель открывается только ими. Включите почту (Resend) или задайте TELEGRAM_BOT_TOKEN.'));
  }
  app.replaceChildren(h('div', { class: 'login' }, card));
  card.querySelector('input:not([disabled])')?.focus();
}

/** Back from Telegram: #tgAuthResult=<base64 JSON>. */
async function telegramReturn() {
  const match = location.hash.match(/tgAuthResult=([^&]+)/);
  if (!match) return false;
  history.replaceState(null, '', location.pathname);
  try {
    const json = atob(match[1].replace(/-/g, '+').replace(/_/g, '/'));
    const authData = JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))));
    const response = await request('POST', '/auth/telegram', { authData, device: device(), admin: true }, false);
    await signedIn(response);
  } catch (error) {
    renderLogin(error.code === 'admin_only' ? 'Этот аккаунт не администратор.' : 'Telegram не подтвердил вход.');
  }
  return true;
}

// ---------- Shell and routes ----------

const SECTIONS = [
  ['overview', 'Обзор', renderOverview],
  ['monetization', 'Монетизация', renderMonetization],
  ['settings', 'Параметры', renderSettings],
  ['catalog', 'Справочники', renderCatalog],
  ['users', 'Пользователи', renderUsers],
  ['audit', 'Журнал', renderAudit],
];

function route() {
  if (!me) return;
  const id = location.hash.replace('#', '') || 'overview';
  const [key, title, render] = SECTIONS.find(([section]) => section === id) ?? SECTIONS[0];
  const main = h('main', {}, h('div', { class: 'page-head' }, h('h1', {}, title)), h('p', { class: 'muted' }, 'Загрузка…'));
  app.replaceChildren(
    h('div', { class: 'shell' },
      h('nav', { class: 'side', 'aria-label': 'Разделы' },
        h('div', { class: 'brand' }, 'Lunex', h('span', {}, 'админка')),
        SECTIONS.map(([section, label]) =>
          h('a', { class: 'nav', href: `#${section}`, 'aria-current': section === key ? 'page' : undefined }, label)),
        h('div', { class: 'who' }, h('div', {}, me.displayName ?? me.email ?? 'Администратор'), h('button', { class: 'quiet small', onclick: signOut }, 'Выйти'))),
      main));
  render(main).catch((error) => {
    main.replaceChildren(h('div', { class: 'page-head' }, h('h1', {}, title)), h('p', { class: 'negative' }, `Не загрузилось: ${error.message}`));
  });
}

function page(main, title, ...content) {
  main.replaceChildren(h('div', { class: 'page-head' }, h('h1', {}, title)), ...content);
}

// ---------- Overview ----------

const FEATURES = { assistant: 'Ассистент', parse_input: 'Разбор фраз', receipt: 'Чеки', insight: 'Инсайты' };
const QUEUES = { maintenance: 'Обслуживание', notifications: 'Уведомления', insights: 'Инсайты', 'auto-save': 'Автонакопления' };
const STATUSES = { active: 'активны', grace_period: 'льготный период', expired: 'истекли', revoked: 'возвращены' };

async function renderOverview(main) {
  const data = await request('GET', '/admin/monitoring');
  const stat = (label, value, extra) => h('div', { class: 'stat' }, h('span', { class: 'muted' }, label), h('span', {}, value, extra ?? ''));

  const totals = {};
  for (const row of data.ai.days) {
    const t = (totals[row.feature] ??= { requests: 0, input: 0, output: 0, failed: 0 });
    t.requests += row.requests;
    t.input += row.inputTokens;
    t.output += row.outputTokens;
    t.failed += row.failed;
  }

  page(main, 'Обзор',
    h('div', { class: 'grid' },
      h('div', { class: 'card' }, h('div', { class: 'label' }, 'Пользователи'), h('div', { class: 'figure' }, fmt(data.users.total)),
        stat('Новых за 7 дней', fmt(data.users.newThisWeek)), stat('Ждут удаления', fmt(data.users.deletedPending))),
      h('div', { class: 'card' }, h('div', { class: 'label' }, 'Подписки и триалы'),
        stat('Триал идёт', fmt(data.subscriptions.trialsActive)), stat('Триал закончился', fmt(data.subscriptions.trialsEnded)),
        Object.entries(STATUSES).map(([status, label]) => stat(`App Store: ${label}`, fmt(data.subscriptions.appStore[status] ?? 0))),
        stat('Промо-доступ', fmt(data.subscriptions.promoActive))),
      h('div', { class: 'card' }, h('div', { class: 'label' }, 'Уведомления App Store'), h('div', { class: 'figure' }, fmt(data.storeEvents.lastDay)),
        h('div', { class: 'muted small' }, 'за сутки'),
        data.storeEvents.failing.length
          ? data.storeEvents.failing.map((event) => h('div', { class: 'stat' }, h('span', { class: 'negative small' }, event.type), h('span', { class: 'small muted' }, dateTime(event.at))))
          : h('div', { class: 'small muted' }, 'Ошибок нет'))),
    h('div', { class: 'card', style: 'margin-bottom:16px' },
      h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' }, h('h2', {}, 'AI за 14 дней'), h('span', { class: 'small muted' }, 'сбои не входят в лимит')),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Функция'), h('th', { class: 'num' }, 'Запросы'), h('th', { class: 'num' }, 'Токены ввода'), h('th', { class: 'num' }, 'Токены вывода'), h('th', { class: 'num' }, 'Сбои'))),
        h('tbody', {}, Object.keys(totals).length
          ? Object.entries(totals).map(([feature, t]) => h('tr', {}, h('td', {}, FEATURES[feature] ?? feature), h('td', { class: 'num' }, fmt(t.requests)), h('td', { class: 'num' }, fmt(t.input)), h('td', { class: 'num' }, fmt(t.output)), h('td', { class: t.failed ? 'num negative' : 'num' }, fmt(t.failed))))
          : h('tr', {}, h('td', { colspan: '5', class: 'empty' }, 'Запросов к AI ещё не было'))))),
      data.ai.days.length
        ? h('details', { style: 'margin-top:12px' }, h('summary', {}, 'По дням'), h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'День'), h('th', {}, 'Функция'), h('th', { class: 'num' }, 'Запросы'), h('th', { class: 'num' }, 'Ввод'), h('th', { class: 'num' }, 'Вывод'), h('th', { class: 'num' }, 'Сбои'))),
          h('tbody', {}, data.ai.days.map((row) => h('tr', {}, h('td', {}, day(row.date)), h('td', {}, FEATURES[row.feature] ?? row.feature), h('td', { class: 'num' }, fmt(row.requests)), h('td', { class: 'num' }, fmt(row.inputTokens)), h('td', { class: 'num' }, fmt(row.outputTokens)), h('td', { class: 'num' }, fmt(row.failed))))))))
        : null),
    h('h2', { style: 'margin:24px 0 12px' }, 'Фоновые задачи'),
    h('div', { class: 'grid' }, data.queues.map((queue) =>
      h('div', { class: 'card' },
        h('div', { class: 'row', style: 'justify-content:space-between' }, h('h3', {}, QUEUES[queue.name] ?? queue.name),
          queue.counts.failed ? h('span', { class: 'pill' }, h('span', { class: 'dot red' }), `${fmt(queue.counts.failed)} с ошибкой`) : h('span', { class: 'pill' }, h('span', { class: 'dot' }), 'в порядке')),
        stat('В очереди', fmt(queue.counts.waiting)), stat('Выполняются', fmt(queue.counts.active)), stat('Отложены', fmt(queue.counts.delayed)), stat('Выполнено (хранится)', fmt(queue.counts.completed)),
        queue.schedules.length ? h('details', {}, h('summary', { class: 'small' }, `Расписание: ${queue.schedules.length}`),
          queue.schedules.map((s) => h('div', { class: 'stat small' }, h('span', { class: 'mono' }, s.name), h('span', { class: 'muted' }, s.pattern ?? '', ' · ', dateTime(s.next))))) : null,
        queue.failed.length ? h('details', {}, h('summary', { class: 'small negative' }, 'Последние ошибки'),
          queue.failed.map((job) => h('div', { class: 'stat small' }, h('span', {}, h('span', { class: 'mono' }, job.name), h('div', { class: 'muted' }, job.reason)), h('span', { class: 'muted' }, dateTime(job.at))))) : null))));
}

// ---------- Monetization ----------

async function renderMonetization(main) {
  const preview = await request('GET', '/admin/monetization');
  const enabled = preview.enabled;
  const confirm = () => confirmAction({
    title: enabled ? 'Выключить Lunex Pro?' : 'Включить Lunex Pro?',
    body: enabled
      ? h('ul', {}, h('li', {}, 'Все функции снова станут бесплатными для всех.'), h('li', {}, 'Экран покупки и счётчик триала скроются в приложении.'), h('li', {}, `Подписки App Store (${fmt(preview.subscribers)}) продолжат продлеваться в App Store.`))
      : h('ul', {},
        h('li', {}, h('b', {}, `${fmt(preview.toFree)} польз.`), ' перейдут на Free: лимиты счетов, целей, AI и аналитики. Данные сохранятся, записи сверх лимита останутся доступны для чтения.'),
        h('li', {}, `${fmt(preview.trials)} на пробном периоде останутся в Pro до его конца.`),
        h('li', {}, `${fmt(preview.subscribers)} подписчиков App Store и ${fmt(preview.promo)} с промо-доступом — без изменений.`),
        h('li', {}, 'В приложении появятся экран Lunex Pro и счётчик триала — при следующем запуске или возврате из фона.')),
    action: enabled ? 'Выключить' : 'Включить',
    danger: enabled,
    run: async () => {
      await request('PUT', '/admin/monetization', { enabled: !enabled });
      route();
      return enabled ? 'Lunex Pro выключен' : 'Lunex Pro включён';
    },
  });
  const stat = (label, value) => h('div', { class: 'stat' }, h('span', { class: 'muted' }, label), h('span', {}, fmt(value)));
  page(main, 'Монетизация',
    h('div', { class: 'grid' },
      h('div', { class: 'card stack' },
        h('div', { class: 'row' }, h('span', { class: enabled ? 'pill ink' : 'pill' }, enabled ? 'Lunex Pro включён' : 'Lunex Pro выключен')),
        h('p', { class: 'muted', style: 'margin:0' }, enabled
          ? 'Pro-функции платные: доступ дают подписка App Store, пробный период и промо-доступ.'
          : 'Сейчас все функции бесплатны для всех, экран покупки скрыт. Пробный период всё равно отсчитывается с регистрации.'),
        h('div', {}, h('button', { class: enabled ? 'danger' : '', onclick: confirm }, enabled ? 'Выключить Lunex Pro' : 'Включить Lunex Pro'))),
      h('div', { class: 'card' }, h('div', { class: 'label' }, 'Пользователи сейчас'),
        stat('Всего', preview.users), stat('Подписка App Store', preview.subscribers), stat('Промо-доступ', preview.promo), stat('Пробный период', preview.trials),
        stat(enabled ? 'На Free' : 'Перейдут на Free при включении', preview.toFree))));
}

// ---------- Settings ----------

const SETTING_LABELS = {
  trial_days: 'Пробный период, дней',
  ai_daily_limit_free: 'Сообщений ассистенту в день, Free',
  ai_daily_limit_pro: 'Сообщений ассистенту в день, Pro',
  ai_daily_limit_parse: 'Разборов голоса и текста в день',
  ai_daily_limit_receipt: 'Распознаваний чеков в день',
  free_max_accounts: 'Счетов на Free',
  free_max_goals: 'Активных целей на Free',
  smart_save_share: 'Доля Smart Save',
};

async function renderSettings(main) {
  const settings = await request('GET', '/admin/settings');
  const rows = settings.filter((s) => s.key !== 'monetization_enabled').map((setting) => {
    const input = h('input', { type: 'number', class: 'narrow', value: String(setting.value), step: setting.key === 'smart_save_share' ? '0.05' : '1', 'aria-label': SETTING_LABELS[setting.key] ?? setting.key });
    const save = h('button', { class: 'small', disabled: true, onclick: async () => {
      save.disabled = true;
      try {
        await request('PUT', `/admin/settings/${setting.key}`, { value: Number(input.value) });
        toast('Сохранено');
        route();
      } catch (error) {
        toast(error.message, true);
        save.disabled = false;
      }
    } }, 'Сохранить');
    input.addEventListener('input', () => {
      const changed = Number(input.value) !== setting.value;
      save.disabled = !changed;
      input.classList.toggle('changed', changed);
    });
    return h('tr', {},
      h('td', {}, h('div', {}, SETTING_LABELS[setting.key] ?? setting.key), h('div', { class: 'small muted' }, setting.description), h('div', { class: 'mono muted' }, setting.key)),
      h('td', {}, input),
      h('td', { class: 'small muted' }, `по умолчанию ${setting.defaultValue}`),
      h('td', { class: 'small muted who-cell' }, setting.updatedBy ? [h('div', {}, setting.updatedBy.name ?? '—'), h('div', {}, dateTime(setting.updatedAt))] : '—'),
      h('td', {}, save));
  });
  page(main, 'Параметры',
    h('p', { class: 'muted' }, 'Изменения доходят до всех серверов за 10 секунд и попадают в журнал. Монетизация — на своей странице.'),
    h('div', { class: 'card table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Параметр'), h('th', {}, 'Значение'), h('th', {}), h('th', {}, 'Изменил'), h('th', {}))),
      h('tbody', {}, rows))));
}

// ---------- Reference data ----------

async function renderCatalog(main) {
  const [currencies, categories] = await Promise.all([request('GET', '/admin/currencies'), request('GET', '/admin/categories')]);

  const currencyRows = currencies.map((currency) => {
    const fields = {
      name: h('input', { class: 'fill', value: currency.name, 'aria-label': 'Название' }),
      symbol: h('input', { class: 'tiny', value: currency.symbol, 'aria-label': 'Символ' }),
      roundingStep: h('input', { class: 'narrow', value: currency.roundingStep, inputmode: 'decimal', 'aria-label': 'Шаг округления' }),
      minSmartSave: h('input', { class: 'narrow', value: currency.minSmartSave, inputmode: 'decimal', 'aria-label': 'Минимум Smart Save' }),
      sortOrder: h('input', { class: 'tiny', type: 'number', value: String(currency.sortOrder), 'aria-label': 'Порядок' }),
      isActive: h('input', { type: 'checkbox', checked: currency.isActive, 'aria-label': 'Активна' }),
    };
    const save = h('button', { class: 'small', disabled: true }, 'Сохранить');
    const patch = () => {
      const result = {};
      for (const [key, input] of Object.entries(fields)) {
        const value = input.type === 'checkbox' ? input.checked : key === 'sortOrder' ? Number(input.value) : input.value.trim();
        if (value !== currency[key]) result[key] = value;
      }
      return result;
    };
    for (const input of Object.values(fields)) {
      input.addEventListener('input', () => {
        save.disabled = Object.keys(patch()).length === 0;
      });
    }
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await request('PATCH', `/admin/currencies/${currency.code}`, patch());
        toast(`${currency.code} сохранена`);
        route();
      } catch (error) {
        toast(error.message, true);
        save.disabled = false;
      }
    });
    return h('tr', {}, h('td', { class: 'mono' }, currency.code), h('td', {}, fields.name), h('td', {}, fields.symbol),
      h('td', {}, fields.roundingStep), h('td', {}, fields.minSmartSave), h('td', {}, fields.sortOrder), h('td', {}, fields.isActive), h('td', {}, save));
  });

  const categoryRow = (category) => {
    const fields = {
      uz: h('input', { class: 'fill', value: category.labels.uz, 'aria-label': 'Название uz' }),
      ru: h('input', { class: 'fill', value: category.labels.ru, 'aria-label': 'Название ru' }),
      en: h('input', { class: 'fill', value: category.labels.en, 'aria-label': 'Название en' }),
      icon: h('input', { class: 'symbol', value: category.icon, 'aria-label': 'SF Symbol' }),
      color: h('input', { type: 'color', value: category.color.toLowerCase(), 'aria-label': 'Цвет' }),
      sortOrder: h('input', { class: 'tiny', type: 'number', value: String(category.sortOrder), 'aria-label': 'Порядок' }),
      isArchived: h('input', { type: 'checkbox', checked: category.isArchived, 'aria-label': 'В архиве' }),
    };
    const save = h('button', { class: 'small', disabled: true }, 'Сохранить');
    const patch = () => {
      const result = {};
      const labels = {};
      for (const language of ['uz', 'ru', 'en']) {
        if (fields[language].value.trim() !== category.labels[language]) labels[language] = fields[language].value.trim();
      }
      if (Object.keys(labels).length) result.labels = labels;
      if (fields.icon.value.trim() !== category.icon) result.icon = fields.icon.value.trim();
      if (fields.color.value.toUpperCase() !== category.color.toUpperCase()) result.color = fields.color.value.toUpperCase();
      if (Number(fields.sortOrder.value) !== category.sortOrder) result.sortOrder = Number(fields.sortOrder.value);
      if (fields.isArchived.checked !== category.isArchived) result.isArchived = fields.isArchived.checked;
      return result;
    };
    for (const input of Object.values(fields)) {
      input.addEventListener('input', () => {
        save.disabled = Object.keys(patch()).length === 0;
      });
    }
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await request('PATCH', `/admin/categories/${category.id}`, patch());
        toast('Категория сохранена');
        route();
      } catch (error) {
        toast(error.message, true);
        save.disabled = false;
      }
    });
    return h('tr', {}, h('td', { class: 'mono' }, category.key ?? '—'), h('td', {}, fields.ru), h('td', {}, fields.uz), h('td', {}, fields.en),
      h('td', {}, fields.icon), h('td', {}, fields.color), h('td', {}, fields.sortOrder), h('td', {}, fields.isArchived), h('td', {}, save));
  };

  const categoryTable = (type, title) => h('div', { class: 'card table-wrap' },
    h('h3', { style: 'margin-bottom:8px' }, title),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Ключ'), h('th', {}, 'ru'), h('th', {}, 'uz'), h('th', {}, 'en'), h('th', {}, 'Иконка'), h('th', {}, 'Цвет'), h('th', {}, 'Порядок'), h('th', {}, 'Архив'), h('th', {}))),
      h('tbody', {}, categories.filter((c) => c.type === type).map(categoryRow))));

  const create = {
    type: h('select', { 'aria-label': 'Тип' }, h('option', { value: 'expense' }, 'Расход'), h('option', { value: 'income' }, 'Доход')),
    key: h('input', { class: 'narrow', placeholder: 'key', 'aria-label': 'Ключ' }),
    ru: h('input', { placeholder: 'Название ru', 'aria-label': 'Название ru' }),
    uz: h('input', { placeholder: 'Nomi uz', 'aria-label': 'Название uz' }),
    en: h('input', { placeholder: 'Name en', 'aria-label': 'Название en' }),
    icon: h('input', { class: 'narrow', placeholder: 'tag', value: 'tag', 'aria-label': 'SF Symbol' }),
    color: h('input', { type: 'color', value: '#557a95', 'aria-label': 'Цвет' }),
  };
  const createForm = h('form', { class: 'row', onsubmit: async (event) => {
    event.preventDefault();
    try {
      await request('POST', '/admin/categories', {
        type: create.type.value,
        key: create.key.value.trim(),
        icon: create.icon.value.trim(),
        color: create.color.value.toUpperCase(),
        labels: { uz: create.uz.value.trim(), ru: create.ru.value.trim(), en: create.en.value.trim() },
      });
      toast('Категория добавлена');
      route();
    } catch (error) {
      toast(error.message, true);
    }
  } }, Object.values(create), h('button', { type: 'submit' }, 'Добавить'));

  page(main, 'Справочники',
    h('div', { class: 'stack' },
      h('div', { class: 'card table-wrap' },
        h('h3', {}, 'Валюты'),
        h('p', { class: 'small muted' }, 'Шаг округления и минимум — для Smart Save и автонакоплений в этой валюте. Доля Smart Save — в «Параметрах».'),
        h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Код'), h('th', {}, 'Название'), h('th', {}, 'Символ'), h('th', {}, 'Шаг'), h('th', {}, 'Минимум'), h('th', {}, 'Порядок'), h('th', {}, 'Активна'), h('th', {}))),
          h('tbody', {}, currencyRows))),
      h('p', { class: 'small muted', style: 'margin:0' }, 'Системные категории: изменения приходят на все устройства со следующей синхронизацией. Иконка — имя SF Symbol без .fill.'),
      categoryTable('expense', 'Категории расходов'),
      categoryTable('income', 'Категории доходов'),
      h('div', { class: 'card stack' }, h('h3', {}, 'Новая системная категория'), createForm)));
}

// ---------- Users ----------

const SOURCES = { trial: 'пробный период', app_store: 'App Store', promo: 'промо', monetization_off: 'монетизация выключена' };

async function renderUsers(main) {
  const query = h('input', { class: 'wide', placeholder: 'Почта, имя, Telegram id или id пользователя', 'aria-label': 'Поиск' });
  const results = h('div', {});
  const search = async () => {
    const q = query.value.trim();
    if (!q) return;
    results.replaceChildren(h('p', { class: 'muted' }, 'Ищу…'));
    try {
      const users = await request('GET', `/admin/users?q=${encodeURIComponent(q)}`);
      results.replaceChildren(users.length
        ? h('div', { class: 'card table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Пользователь'), h('th', {}, 'Вход'), h('th', {}, 'План'), h('th', {}, 'Создан'), h('th', {}, 'Промо-доступ'))),
          h('tbody', {}, users.map(userRow))))
        : h('p', { class: 'empty' }, 'Никого не нашлось.'));
    } catch (error) {
      results.replaceChildren(h('p', { class: 'negative' }, error.message));
    }
  };
  const userRow = (user) => {
    const days = h('input', { type: 'number', class: 'tiny', value: '30', min: '1', max: '3650', 'aria-label': 'Дней' });
    const grant = h('button', { class: 'small', disabled: Boolean(user.deletedAt), onclick: () => {
      const count = Number(days.value);
      if (!Number.isInteger(count) || count < 1 || count > 3650) {
        toast('Число дней — от 1 до 3650', true);
        return;
      }
      const from = user.promoUntil && new Date(user.promoUntil) > new Date() ? new Date(user.promoUntil) : new Date();
      confirmAction({
        title: `Выдать Pro на ${fmt(count)} дн.?`,
        body: h('p', {}, user.email ?? user.name ?? user.id, h('br'), `Lunex Pro до ${day(new Date(from.getTime() + count * 86_400_000))}`,
          user.promoUntil ? ' — продление текущего промо-доступа.' : '.'),
        action: 'Выдать',
        run: async () => {
          const updated = await request('POST', `/admin/users/${user.id}/promo`, { days: count });
          search();
          return `Промо-доступ до ${day(updated.promoUntil)}`;
        },
      });
    } }, 'Выдать Pro');
    return h('tr', {},
      h('td', {}, h('div', {}, user.name ?? user.email ?? 'Без имени', user.role === 'admin' ? h('span', { class: 'pill', style: 'margin-left:6px' }, 'admin') : null),
        h('div', { class: 'small muted' }, user.email ?? ''), h('div', { class: 'mono muted' }, user.id)),
      h('td', { class: 'small' }, user.signIn.join(', ') || '—'),
      h('td', {}, h('span', { class: user.plan === 'pro' ? 'pill ink' : 'pill' }, user.plan === 'pro' ? 'Pro' : 'Free'),
        h('div', { class: 'small muted' }, [SOURCES[user.source] ?? '', user.expiresAt ? ` до ${day(user.expiresAt)}` : ''].join('')),
        user.promoUntil ? h('div', { class: 'small muted' }, `промо до ${day(user.promoUntil)}`) : null,
        user.trialUntil ? h('div', { class: 'small muted' }, `триал ${new Date(user.trialUntil) > new Date() ? 'до' : 'закончился'} ${day(user.trialUntil)}`) : null),
      h('td', { class: 'small muted' }, user.deletedAt ? `удалён ${day(user.deletedAt)}` : day(user.createdAt)),
      h('td', {}, h('div', { class: 'row' }, days, h('span', { class: 'small muted' }, 'дн.'), grant)));
  };
  page(main, 'Пользователи',
    h('form', { class: 'row', style: 'margin-bottom:16px;flex-wrap:nowrap', onsubmit: (event) => {
      event.preventDefault();
      search();
    } }, query, h('button', { type: 'submit' }, 'Найти')),
    h('p', { class: 'small muted' }, 'Промо-доступ даёт Lunex Pro на выбранное число дней; повторная выдача добавляется к текущей.'),
    results);
  query.focus();
}

// ---------- Audit log ----------

const ACTIONS = {
  'monetization.enable': 'Включил Lunex Pro',
  'monetization.disable': 'Выключил Lunex Pro',
  'setting.update': 'Изменил параметр',
  'subscription.grant': 'Выдал промо-доступ',
  'currency.update': 'Изменил валюту',
  'category.update': 'Изменил категорию',
  'category.create': 'Добавил категорию',
};

async function renderAudit(main) {
  const body = h('tbody', {});
  const more = h('button', { class: 'secondary', hidden: true }, 'Показать ещё');
  const json = (value) => (value === null || value === undefined ? '—' : h('pre', { class: 'mono' }, typeof value === 'object' ? JSON.stringify(value, null, 1) : String(value)));
  let before;
  const load = async () => {
    more.disabled = true;
    const data = await request('GET', `/admin/audit?limit=50${before ? `&before=${before}` : ''}`);
    for (const entry of data.items) {
      body.append(h('tr', {}, h('td', { class: 'small muted' }, dateTime(entry.createdAt)), h('td', { class: 'small' }, entry.admin.name ?? entry.admin.id),
        h('td', {}, ACTIONS[entry.action] ?? entry.action, h('div', { class: 'mono muted' }, entry.target ?? '')), h('td', {}, json(entry.oldValue)), h('td', {}, json(entry.newValue))));
    }
    if (!body.children.length) body.append(h('tr', {}, h('td', { colspan: '5', class: 'empty' }, 'Действий пока не было')));
    before = data.nextBefore;
    more.hidden = !before;
    more.disabled = false;
  };
  more.addEventListener('click', () => load().catch((error) => toast(error.message, true)));
  page(main, 'Журнал',
    h('div', { class: 'card table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Когда'), h('th', {}, 'Кто'), h('th', {}, 'Что'), h('th', {}, 'Было'), h('th', {}, 'Стало'))), body)),
    h('div', { style: 'margin-top:16px' }, more));
  await load();
}

// ---------- Start ----------

window.addEventListener('hashchange', () => {
  if (me && !location.hash.includes('tgAuthResult')) route();
});

(async () => {
  if (await telegramReturn()) return;
  if (await refresh()) {
    try {
      me = await request('GET', '/admin/me');
      route();
      return;
    } catch {
      signOutLocally();
    }
  }
  renderLogin();
})();
