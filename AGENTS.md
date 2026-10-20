# Lunex Finance — AGENTS.md

> The product spec and data schema of this project, exported from Coddle Studio (https://coddle.uz/studio/synetra/lunex-finance/lunex-finance-spec). Coddle is the source of truth: read the spec there before a step, tick plan steps and acceptance criteria there as they are done, and export this file again.

## Product

Lunex Finance — нативное iOS-приложение для личных финансов, написанное с нуля на смену Telegram-боту Lunex (бот полностью выключается). На главном экране сразу видно, сколько можно спокойно потратить сегодня. Операция записывается за 2–3 касания, голосом или по фото чека. Деньги откладываются в цели сами: Smart Save, автонакопления и округление расходов. AI-ассистент объясняет, куда уходят деньги, и подсказывает следующий шаг. Приложение работает офлайн, поддерживает узбекский, русский и английский языки, несколько счетов и валют, виджеты и Siri.

**Stack:** iOS 18+, Swift 6, SwiftUI, SwiftData, Swift Charts, WidgetKit, App Intents, StoreKit 2, VisionKit, Speech; бэкенд NestJS (TypeScript), Prisma, PostgreSQL, Redis + BullMQ; Claude API; APNs

## Users and roles

- **Гость** — видит приветствие и входит через Apple, Google, Telegram или по коду на почту.
- **Пользователь** — ведёт счета, операции, бюджет, цели, автонакопления и регулярные платежи; пользуется Smart Save, аналитикой, AI-ассистентом, виджетами и Siri; получает 30 дней Lunex Pro при регистрации; управляет подпиской, настройками, экспортом и удалением аккаунта.
- **Администратор** — через веб-панель ведёт справочники валют и системных категорий и параметры приложения, одной кнопкой с подтверждением включает монетизацию, выдаёт промо-доступ Pro, смотрит метрики, фоновые задачи и расход AI.
- **Система** — фоновые задачи сервера: курсы валют, регулярные платежи, автонакопления, ежедневные предложения Smart Save, AI-отчёты, push-уведомления, истечение триалов и подписок, обработка уведомлений App Store, очистка удалённых аккаунтов.

## Features and acceptance criteria

### Вход и аккаунт
Быстрый вход без паролей через соцсети или почту и единый аккаунт на всех устройствах.
- [ ] Sign in with Apple — одним касанием
- [ ] Вход через Google (OAuth 2.0 / OpenID Connect); бэкенд проверяет ID-токен
- [ ] Вход через Telegram (Telegram Login) в ASWebAuthenticationSession; бэкенд проверяет подпись данных токеном бота-авторизатора, у которого нет никакой логики, кроме входа
- [x] Вход по почте одноразовым кодом: 6 цифр, действует 10 минут, не больше 5 попыток, повторная отправка через 60 секунд
- [ ] Если провайдер вернул подтверждённую почту, которая уже есть у аккаунта, способ входа привязывается к нему автоматически; в настройках способы входа можно привязать и отвязать вручную (последний отвязать нельзя)
- [ ] Сессия — access-токен на 15 минут и refresh-токен на 60 дней в Keychain; refresh-токен обновляется при каждом использовании
- [x] В настройках есть «Выйти на всех устройствах» и «Удалить аккаунт» (требование App Store): данные стираются через 30 дней, до этого вход восстанавливает аккаунт

### Онбординг
Настройка меньше чем за минуту, каждый шаг можно пропустить.
- [x] Шаги: язык (по умолчанию системный) → базовая валюта → фокус («Копить на цель», «Контролировать расходы», «Жить по бюджету») → примерный доход в месяц → первая цель по шаблону → разрешение на уведомления с объяснением пользы
- [x] Шаблоны целей: телефон, машина, дом, путешествие, учёба, подушка безопасности, свадьба, гаджет — с готовыми emoji и цветом
- [x] Автоматически создаётся счёт «Наличные» в базовой валюте
- [ ] После онбординга на главном экране висит чек-лист «Первые шаги»: первая операция, цель, бюджет, виджет; он исчезает, когда всё выполнено (заменяет адаптивное меню бота)

### Главный экран
Вся картина дня на одном экране, без меню и навигации.
- [x] Главная цифра — «Можно потратить сегодня» с кольцом прогресса; цвет меняется при перерасходе
- [x] Блоки: общий баланс по счетам, траты месяца против плана, карточка основной цели с прогрессом, карточка Smart Save, ближайшие регулярные платежи, последние 5 операций
- [ ] Большая кнопка «+» открывает быстрое добавление; долгое нажатие — голосовой ввод
- [x] Обновление жестом pull-to-refresh, данные из локальной базы показываются мгновенно
- [x] Жест или кнопка «глаз» скрывает все суммы (режим приватности)

### Быстрое добавление операции
Запись расхода за 2–3 касания вместо пятишагового мастера бота.
- [x] Нижняя шторка с собственной цифровой клавиатурой и простыми вычислениями (+ − ×)
- [x] Переключатель «Расход / Доход / Перевод»; по умолчанию «Расход»
- [x] Сетка категорий, где первыми идут недавние и частые; счёт по умолчанию из настроек; дата «Сегодня / Вчера / календарь»; заметка необязательна
- [x] Сохранение одним касанием, тактильный отклик, тост «Отменить» на 5 секунд
- [x] Работает без сети: операция сохраняется локально и синхронизируется позже
- [x] После сохранения «Можно потратить сегодня» пересчитывается мгновенно

### Голосовой и текстовый ввод
Операция записывается фразой: «кофе 25 тысяч», «зарплата 8 млн вчера», «taksi 30 ming».
- [ ] Речь распознаётся на устройстве (Speech framework) на uz / ru / en
- [ ] AI-разбор фразы возвращает тип, сумму, категорию, дату, заметку и уверенность
- [ ] Перед сохранением показывается заполненная карточка; любое поле можно поправить
- [ ] Одна фраза может содержать несколько операций («обед 40 000 и такси 15 000»)

### Сканирование чека
- [ ] Чек снимается камерой (VisionKit) или выбирается из фото
- [ ] Сумма, дата и магазин распознаются на устройстве, а при низкой уверенности — на сервере
- [ ] Фото прикрепляется к операции и открывается из её карточки

### История операций
Полный контроль над записями — в боте операции нельзя было изменить или удалить.
- [x] Список сгруппирован по дням с итогом каждого дня, подгружается при прокрутке
- [x] Поиск по заметке, магазину, категории и сумме
- [x] Фильтры по типу, счёту, категории и периоду; фильтры можно комбинировать
- [x] Свайп по строке — изменить или удалить; удаление можно отменить
- [ ] Карточка операции: все поля, вложения, источник (вручную, голос, чек, регулярная), редактирование

### Счета и переводы
- [x] Счета: наличные, карта, банк, сбережения, другое; у каждого своя валюта, начальный баланс, иконка и цвет
- [x] Перевод между счетами не считается ни расходом, ни доходом; при разных валютах подставляется курс дня, его можно изменить
- [x] Общий баланс считается в базовой валюте по текущему курсу; счёт можно исключить из общего баланса
- [x] Счёт можно архивировать — история сохраняется

### Категории
- [x] Системные категории расходов: еда, транспорт, супермаркет, покупки, подписки, развлечения, здоровье, жильё, коммунальные услуги, образование, кафе, подарки
- [x] Системные категории доходов: зарплата, перевод, бизнес, продажа, подарок, фриланс, кешбэк
- [x] Свои категории с иконкой из SF Symbols и цветом, один уровень подкатегорий
- [x] Порядок меняется перетаскиванием; категорию можно архивировать, а не удалять

### Валюты и курсы
- [x] Базовая валюта задаётся в онбординге и меняется в настройках
- [x] Курсы ЦБ Узбекистана загружаются раз в день; операция хранит сумму в базовой валюте по курсу на дату операции
- [x] Итоги, бюджет и аналитика считаются в базовой валюте; цель хранится в своей валюте

### Месячный бюджет
Бюджет работает сразу без настройки, как в боте, а при желании настраивается подробно.
- [x] Авто-режим без настройки: дневной лимит считается по фактическим доходам месяца (или по доходу из онбординга)
- [x] Мастер настройки: план дохода, общий лимит, цель накоплений на месяц, лимиты по категориям; лимиты предлагаются по средним тратам за последние 3 месяца
- [x] Бюджетный месяц начинается с дня зарплаты (`month_starts_on_day`)
- [x] Экран бюджета: план против факта, прогресс-бары по категориям, «Можно потратить сегодня», прогноз на конец месяца
- [x] Остаток можно перенести на следующий месяц (rollover)
- [x] Уведомления при 80 % и 100 % лимита категории и общего лимита — по одному на событие

### Регулярные платежи и подписки
- [x] Правило: название, сумма, категория, счёт, частота (день / неделя / месяц / год, каждые N), дата начала и окончания
- [x] Режимы: создавать операцию автоматически или только напоминать за N дней
- [x] Экран подписок: список, сумма в месяц и в год, ближайшие списания
- [x] Предстоящие платежи до конца месяца учитываются в дневном лимите
- [x] Приложение распознаёт повторяющиеся траты и предлагает сделать их регулярными

### Цели накоплений
- [ ] Создание: название, emoji, цвет, обложка, сумма, валюта, дедлайн (+30 / +90 / +180 / +365 дней, календарь или без срока), счёт-копилка
- [x] Расчёт нужного взноса в день, неделю и месяц до дедлайна и статус «В графике / Отстаёт / Опережает»
- [x] Пополнение и снятие со счёта; история всех взносов с источником (вручную, Smart Save, автонакопление, округление)
- [x] Одна основная цель; первая созданная цель становится основной автоматически
- [x] Приоритет меняется перетаскиванием в списке
- [x] Цель можно поставить на паузу, завершить и архивировать или вернуть в работу
- [x] Этапы 25 / 50 / 75 / 100 % отмечаются анимацией и уведомлением — один раз на этап
- [x] При достижении суммы цель становится «Достигнута» с праздничным экраном и предложением выбрать следующую цель

### Автонакопления
Деньги откладываются сами по правилам пользователя.
- [x] Фиксированная сумма по расписанию (каждый день, неделю или месяц)
- [x] Процент от каждого дохода
- [x] Округление каждого расхода до 1 000 / 5 000 / 10 000 сум, разница уходит в цель
- [x] Правила выполняются на сервере; если на счёте не хватает денег, взнос пропускается, а пользователь получает уведомление
- [x] О выполнении приходит тихое уведомление (одно в день на правило), взнос виден в истории цели

### Smart Save
Развитие Smart Save из бота: ежедневное предложение, которое принимается одним касанием.
- [x] Каждое утро сервер рассчитывает безопасную сумму и показывает её карточкой на главном экране и push-уведомлением
- [x] Карточка объясняет, почему сумма именно такая: доход, траты, предстоящие платежи, оставшиеся дни
- [x] Варианты: «Отложить», «Изменить сумму» (слайдер, только в меньшую сторону) и «Не сегодня»; принять можно прямо из уведомления
- [x] Принятие не чаще одного раза в день; при подтверждении сервер пересчитывает сумму, и если она уменьшилась — показывает новую
- [x] Понятные состояния: нет цели, нет свободных денег, сумма слишком мала, уже отложено сегодня, цель достигнута
- [x] Для цели в другой валюте сумма пересчитывается по курсу дня и показывается в обеих валютах

### Аналитика
Интерактивные графики на Swift Charts.
- [x] Расходы по категориям (кольцевая диаграмма); касание сегмента открывает операции этой категории
- [x] Динамика расходов и доходов по дням, неделям и месяцам с выбором периода
- [x] Сравнение с прошлым периодом в процентах по каждой категории
- [x] Календарь трат: интенсивность по дням
- [x] Прогресс всех целей и общая сумма накоплений по валютам

### AI-инсайты и отчёты
- [x] Совет дня на главном экране
- [x] Еженедельный отчёт по воскресеньям и месячный отчёт — с цифрами, графиком и одной рекомендацией
- [x] Анализ цели: краткий вывод, рекомендация и оценка 0–100
- [x] Поиск аномалий: трата больше трёх медиан категории за 90 дней
- [x] Прогноз бюджета: уложится ли пользователь в лимит к концу месяца
- [x] Лента инсайтов с отметкой «прочитано»; всё на языке пользователя

### AI-ассистент
Чат, который отвечает на вопросы по данным пользователя.
- [ ] Отвечает на вопросы вроде «Сколько я потратил на кафе в сентябре?» и «Когда я накоплю на машину?» по реальным данным
- [ ] Ответы содержат цифры и мини-графики; предложенные действия (создать цель, задать лимит, создать регулярный платёж) выполняются только после подтверждения
- [ ] Дневной лимит сообщений: 5 в Free, 50 в Pro (настраивается в админке); в чате виден счётчик «осталось N»
- [ ] При сбое AI показывается понятное сообщение и кнопка «Повторить»; неудачный запрос не списывается с лимита
- [ ] История диалогов сохраняется, её можно удалить

### Уведомления
- [x] Вечернее напоминание записать траты в выбранное время; не приходит, если сегодня уже есть операции
- [ ] Бюджет 80 % и 100 %, этапы цели, дедлайн цели через 7 дней, регулярный платёж, Smart Save, выполненное автонакопление, еженедельный отчёт
- [x] Каждый тип включается и выключается отдельно; в тихие часы (22:00–08:00) уведомления не приходят; не больше 3 уведомлений в день, кроме тех, что пользователь запросил сам
- [x] Уведомления с действиями: «Отложить» для Smart Save, «Записать» для регулярного платежа; касание открывает нужный экран

### Виджеты, Siri и быстрые действия
- [x] Виджеты на домашнем экране: «Можно потратить сегодня», прогресс цели, кнопки быстрого добавления (интерактивные виджеты)
- [ ] Виджеты на экране блокировки: дневной лимит и прогресс основной цели
- [x] App Intents и Siri: «Добавь расход 30 000 на такси в Lunex», «Сколько я могу потратить сегодня?»; действия доступны в Shortcuts
- [ ] Быстрые действия на иконке приложения: расход, доход, скан чека
- [x] Кнопка быстрого добавления в Пункте управления и на кнопке «Действие»

### Офлайн и синхронизация
- [ ] Все данные лежат в локальной базе SwiftData, и любое действие работает без сети
- [x] Изменения ставятся в очередь и отправляются при появлении сети; ID записей генерируются на клиенте, поэтому повторная отправка безопасна
- [x] Синхронизация инкрементальная по `updated_at`, удаления передаются через `deleted_at`; конфликты решаются по последней записи
- [x] Индикатор «Не синхронизировано» и время последней синхронизации видны в настройках
- [x] Данные одинаковы на всех iPhone одного аккаунта; локальные изменения идут через очередь операций в SwiftData, и запись с неотправленным изменением не перезаписывается серверной версией

### Безопасность и приватность
- [x] Блокировка через Face ID / Touch ID / код-пароль при запуске и после N секунд в фоне
- [x] Размытие содержимого в переключателе приложений
- [x] Режим скрытых сумм
- [ ] Токены хранятся в Keychain, обмен идёт только по TLS, почта и токены маскируются в логах
- [ ] Экспорт всех своих данных и удаление аккаунта из настроек

### Экспорт
- [ ] Экспорт операций за период в CSV и PDF-отчёт с графиками через Share Sheet

### Настройки и персонализация
- [x] Язык приложения uz / ru / en независимо от языка системы, применяется сразу
- [x] Базовая валюта, счёт по умолчанию, день начала месяца, первый день недели
- [x] Тема (системная, светлая, тёмная), тактильная отдача
- [ ] Управление категориями, счетами, регулярными платежами, автонакоплениями и уведомлениями

### Lunex Pro и пробный период
Платная подписка готова в коде, но включается позже одной кнопкой; до этого все функции бесплатны.
- [ ] При первой регистрации пользователь получает 30 дней Lunex Pro (`trial_days`); новый способ входа или повторный вход триал не продлевает
- [ ] Пока монетизация выключена (`monetization_enabled = false`), Pro-функции доступны всем, экран покупки и счётчик триала скрыты
- [ ] Флаг монетизации и лимиты приложение получает с сервера при запуске и при возврате из фона, поэтому включение не требует обновления приложения
- [ ] После включения: экран Lunex Pro с месячной и годовой подпиской (StoreKit 2), «Восстановить покупки», бейдж «Pro · осталось N дней» во время триала
- [ ] Сервер проверяет покупки через App Store Server API и обрабатывает App Store Server Notifications V2 (продление, отмена, возврат, grace period); одно событие не обрабатывается дважды
- [ ] По окончании Pro данные не удаляются: записи сверх лимитов Free остаются доступны для чтения, создать новые сверх лимита нельзя
- [ ] Free: операции, до 2 счетов, до 3 активных целей, авто-бюджет, Smart Save, регулярные платежи, аналитика за текущий и прошлый месяц, совет дня, виджеты, 5 сообщений AI-ассистенту в день
- [ ] Pro: счета и цели без ограничений, лимиты по категориям и перенос остатка, автонакопления, голосовой ввод и скан чеков, AI-отчёты и анализ целей, 50 сообщений AI-ассистенту в день, аналитика за любой период, экспорт CSV / PDF

### Качество интерфейса и доступность
- [ ] Dynamic Type, VoiceOver, достаточный контраст, тёмная тема на всех экранах
- [ ] Пустые состояния с понятным действием, skeleton-загрузка, плавные анимации переходов
- [ ] Корректная вёрстка от iPhone SE до Pro Max
- [ ] Холодный старт до 1 секунды, главный экран читается из локальной базы без ожидания сети

### Администрирование
- [ ] Вход в веб-панель только для пользователей с ролью `admin` через те же способы входа
- [ ] Справочники: валюты, системные категории и их переводы, параметры Smart Save (доля, минимум, шаг округления)
- [ ] Параметры приложения: длительность триала, лимиты Free и Pro, дневные лимиты AI
- [ ] Монетизация включается одной кнопкой «Включить Lunex Pro»; в окне подтверждения видно, что изменится и сколько пользователей перейдут на Free; выключается так же
- [ ] Выдача промо-доступа Pro пользователю на N дней
- [ ] Каждое действие администратора записывается в журнал: кто, когда, что было и что стало
- [ ] Мониторинг: фоновые задачи, ошибки AI, расход токенов по дням и функциям, подписки и триалы

## Screens

- `/welcome` — приветствие и кнопки входа: Apple, Google, Telegram, почта (Гость)
- `/auth/email` — ввод почты и одноразового кода (Гость)
- `/onboarding` — язык, валюта, фокус, доход, первая цель, уведомления (Пользователь)
- `/lock` — разблокировка Face ID / кодом (Пользователь)
- `/home` — главный экран: можно потратить сегодня, баланс, цель, Smart Save, последние операции (Пользователь)
- `/add` — шторка быстрого добавления операции (Пользователь)
- `/add/voice` — голосовой и текстовый ввод с AI-разбором (Пользователь)
- `/add/scan` — сканирование чека (Пользователь)
- `/transactions` — история с поиском и фильтрами (Пользователь)
- `/transactions/:id` — карточка и редактирование операции (Пользователь)
- `/accounts` — счета и общий баланс (Пользователь)
- `/accounts/:id` — счёт, его операции, перевод (Пользователь)
- `/budget` — бюджет месяца: план против факта, категории, прогноз (Пользователь)
- `/budget/setup` — мастер настройки бюджета и лимитов (Пользователь)
- `/recurring` — регулярные платежи и подписки (Пользователь)
- `/goals` — список целей с перетаскиванием приоритета (Пользователь)
- `/goals/new` — создание цели по шаблону (Пользователь)
- `/goals/:id` — цель: прогресс, график взносов, история, действия (Пользователь)
- `/goals/:id/contribute` — пополнение или снятие (Пользователь)
- `/goals/:id/auto-save` — правила автонакоплений (Пользователь)
- `/smart-save` — предложение Smart Save с объяснением (Пользователь)
- `/analytics` — графики и сравнение периодов (Пользователь)
- `/insights` — лента AI-инсайтов и отчётов (Пользователь)
- `/assistant` — чат с AI-ассистентом (Пользователь)
- `/notifications` — центр уведомлений (Пользователь)
- `/settings` — язык, валюта, тема, синхронизация (Пользователь)
- `/settings/categories` — управление категориями (Пользователь)
- `/settings/notifications` — типы уведомлений, время напоминания, тихие часы (Пользователь)
- `/settings/security` — Face ID, автоблокировка, скрытие сумм (Пользователь)
- `/settings/export` — экспорт CSV / PDF (Пользователь)
- `/settings/account` — привязка способов входа, статус Pro, выход, удаление аккаунта (Пользователь)
- `/pro` — экран Lunex Pro: сравнение Free и Pro, покупка, восстановление; скрыт до включения монетизации (Пользователь)
- `/admin` — веб-панель: справочники, параметры, кнопка монетизации, промо-доступ, журнал, мониторинг (Администратор)

## Data

- **Валюта** → `currencies` — код ISO, символ, точность, шаг округления и минимум Smart Save
- **Курс валюты** → `exchange_rates` — ежедневные курсы ЦБ Узбекистана
- **Пользователь** → `users` — профиль, почта, роль, язык, базовая валюта, часовой пояс, фокус и статус онбординга
- **Способ входа** → `auth_identities` — Apple, Google, Telegram или почта
- **Код входа по почте** → `email_verifications` — одноразовые коды с ограничением попыток и срока
- **Устройство** → `devices` — iPhone пользователя, APNs-токен, время синхронизации
- **Refresh-токен** → `refresh_tokens` — сессии по устройствам
- **Настройки** → `user_settings` — безопасность, уведомления, начало месяца и недели, счёт по умолчанию
- **Счёт** → `accounts` — наличные, карты, сбережения со своей валютой и балансом
- **Категория** → `categories` — системные и пользовательские категории с иконкой и цветом
- **Настройка категории** → `category_preferences` — порядок и архив системных категорий у конкретного пользователя
- **Перевод категории** → `category_translations` — названия системных категорий на uz / ru / en
- **Операция** → `transactions` — доход, расход или перевод с суммой в базовой валюте и источником ввода
- **Вложение** → `transaction_attachments` — фото чеков и результат распознавания
- **Регулярный платёж** → `recurring_rules` — подписки, аренда, зарплата с расписанием
- **Бюджет** → `budgets` — бюджетный месяц: план дохода, общий лимит, цель накоплений, перенос остатка
- **Лимит категории** → `budget_category_limits` — лимиты по категориям с порогом уведомления
- **Цель** → `goals` — цель накоплений с валютой, дедлайном, статусом, приоритетом и счётом-копилкой
- **Взнос в цель** → `goal_contributions` — пополнения и снятия с источником
- **Этап цели** → `goal_milestones` — достигнутые 25 / 50 / 75 / 100 %
- **Правило автонакопления** → `auto_save_rules` — фиксированная сумма, процент от дохода, округление
- **Предложение Smart Save** → `smart_save_suggestions` — ежедневная безопасная сумма с расчётом и решением пользователя
- **AI-инсайт** → `ai_insights` — советы, отчёты, анализ целей, аномалии, прогнозы
- **Диалог с ассистентом** → `ai_conversations` — чаты пользователя с AI
- **Сообщение ассистента** → `ai_messages` — реплики и предложенные действия
- **Уведомление** → `notifications` — запланированные и отправленные push с защитой от дублей
- **Подписка** → `subscriptions` — триал, покупки App Store и промо-доступ Lunex Pro
- **Событие App Store** → `store_events` — уведомления App Store Server Notifications V2
- **Расход AI** → `ai_usage_daily` — запросы и токены по дням и функциям для лимитов
- **Параметр приложения** → `app_settings` — флаг монетизации, длительность триала, лимиты Free / Pro и AI
- **Журнал администратора** → `admin_audit_log` — действия администраторов со значениями до и после

### Schema: lunex-finance-db (https://coddle.uz/studio/synetra/lunex-finance/lunex-finance-db)

```dbml
Project lunex_finance {
  database_type: 'PostgreSQL'
  Note: 'Lunex Finance — iOS-приложение личных финансов. Клиент офлайн-first (SwiftData), сервер — источник правды и синхронизация по updated_at / deleted_at. Идентификаторы пользовательских данных — UUID, генерируются на клиенте.'
}

// ---------- Справочники ----------

Enum language_code {
  uz
  ru
  en
}

Enum category_type {
  income
  expense
}

Table currencies {
  id int [pk, increment]
  code char(3) [not null, unique, note: 'ISO 4217: UZS, USD, EUR, RUB, KZT']
  name varchar(64) [not null]
  symbol varchar(8) [not null]
  decimals smallint [not null, default: 2, note: 'Знаков после запятой при отображении (UZS — 0)']
  rounding_step numeric(18,2) [not null, default: 1, note: 'Шаг округления сумм Smart Save и автонакоплений (UZS — 1000)']
  min_smart_save numeric(18,2) [not null, default: 1, note: 'Минимальная сумма Smart Save (UZS — 1000)']
  is_active boolean [not null, default: true]
  sort_order int [not null, default: 0]
}

Table exchange_rates {
  id bigint [pk, increment]
  base_currency_id int [not null, ref: > currencies.id]
  quote_currency_id int [not null, ref: > currencies.id]
  rate numeric(20,10) [not null, note: '1 base = rate quote']
  rate_date date [not null]
  source varchar(32) [not null, default: 'cbu', note: 'cbu — Центральный банк Узбекистана']
  created_at timestamptz [not null, default: `now()`]
  updated_at timestamptz [not null, default: `now()`, note: 'Меняется при исправлении курса — по нему приложение получает новые курсы']

  indexes {
    (base_currency_id, quote_currency_id, rate_date) [unique]
    quote_currency_id
    updated_at
  }
}

// ---------- Пользователи, вход, устройства ----------

Enum auth_provider {
  apple
  google
  telegram [note: 'Telegram Login (OAuth), subject — Telegram user id']
  email [note: 'Одноразовый код на почту']
}

Enum user_role {
  user
  admin
}

Enum onboarding_focus {
  save [note: 'Копить на цель']
  track [note: 'Контролировать расходы']
  budget [note: 'Жить по бюджету']
}

Enum device_platform {
  ios
  ipados [note: 'Следующие релизы']
  watchos [note: 'Следующие релизы']
}

Table users {
  id uuid [pk, default: `gen_random_uuid()`]
  display_name varchar(128)
  email varchar(255) [unique, note: 'Подтверждённая почта; по ней автоматически связываются способы входа']
  email_verified_at timestamptz
  role user_role [not null, default: 'user']
  avatar_key varchar(255)
  language language_code [not null, default: 'uz']
  base_currency_id int [not null, ref: > currencies.id, note: 'Все итоги и бюджет считаются в ней']
  timezone varchar(64) [not null, default: 'Asia/Tashkent']
  onboarding_focus onboarding_focus
  monthly_income_estimate numeric(18,2) [note: 'Указан в онбординге, используется до первого реального дохода']
  onboarding_completed_at timestamptz
  created_at timestamptz [not null, default: `now()`]
  updated_at timestamptz [not null, default: `now()`]
  deleted_at timestamptz [note: 'Удаление аккаунта: данные стираются через 30 дней']

  indexes {
    base_currency_id
  }
}

Table auth_identities {
  id bigint [pk, increment]
  user_id uuid [not null, ref: > users.id]
  provider auth_provider [not null]
  subject varchar(255) [not null, note: 'Apple sub, Google sub, Telegram user id или почта']
  email varchar(255)
  created_at timestamptz [not null, default: `now()`]
  last_used_at timestamptz

  indexes {
    (provider, subject) [unique]
    user_id
  }
}

Table email_verifications {
  id uuid [pk, default: `gen_random_uuid()`]
  email varchar(255) [not null]
  code_hash varchar(128) [not null]
  attempts smallint [not null, default: 0, note: 'Не более 5 попыток']
  expires_at timestamptz [not null, note: 'created_at + 10 минут']
  verified_at timestamptz
  created_at timestamptz [not null, default: `now()`]

  indexes {
    (email, created_at)
  }
}

Table devices {
  id uuid [pk, default: `gen_random_uuid()`]
  user_id uuid [not null, ref: > users.id]
  platform device_platform [not null, default: 'ios']
  model varchar(64)
  os_version varchar(32)
  app_version varchar(32)
  apns_token varchar(255) [unique]
  push_enabled boolean [not null, default: false]
  last_sync_at timestamptz
  last_seen_at timestamptz
  created_at timestamptz [not null, default: `now()`]

  indexes {
    user_id
  }
}

Table refresh_tokens {
  id uuid [pk, default: `gen_random_uuid()`]
  user_id uuid [not null, ref: > users.id]
  device_id uuid [not null, ref: > devices.id]
  token_hash varchar(128) [not null, unique]
  expires_at timestamptz [not null]
  revoked_at timestamptz
  created_at timestamptz [not null, default: `now()`]

  indexes {
    user_id
    device_id
  }
}

Table user_settings {
  user_id uuid [pk, ref: - users.id]
  biometric_lock_enabled boolean [not null, default: false]
  lock_after_seconds int [not null, default: 60]
  hide_amounts boolean [not null, default: false]
  week_starts_on smallint [not null, default: 1, note: '1 — понедельник']
  month_starts_on_day smallint [not null, default: 1, note: 'День зарплаты: с него начинается бюджетный месяц']
  default_account_id uuid [ref: > accounts.id]
  daily_reminder_enabled boolean [not null, default: true]
  daily_reminder_time time [not null, default: '21:00']
  budget_alerts_enabled boolean [not null, default: true]
  goal_alerts_enabled boolean [not null, default: true]
  recurring_alerts_enabled boolean [not null, default: true]
  smart_save_enabled boolean [not null, default: true]
  weekly_report_enabled boolean [not null, default: true]
  quiet_hours_start time [not null, default: '22:00']
  quiet_hours_end time [not null, default: '08:00']
  haptics_enabled boolean [not null, default: true]
  updated_at timestamptz [not null, default: `now()`]

  indexes {
    default_account_id
  }
}

// ---------- Счета, категории, операции ----------

Enum account_type {
  cash
  card
  bank
  savings
  other
}

Table accounts {
  id uuid [pk]
  user_id uuid [not null, ref: > users.id]
  name varchar(64) [not null]
  type account_type [not null, default: 'cash']
  currency_id int [not null, ref: > currencies.id]
  initial_balance numeric(18,2) [not null, default: 0]
  current_balance numeric(18,2) [not null, default: 0, note: 'Кеш: initial + доходы − расходы ± переводы ± взносы в цели']
  icon varchar(64) [note: 'SF Symbol']
  color char(7)
  include_in_total boolean [not null, default: true]
  is_archived boolean [not null, default: false]
  sort_order int [not null, default: 0]
  created_at timestamptz [not null, default: `now()`]
  updated_at timestamptz [not null, default: `now()`]
  deleted_at timestamptz

  indexes {
    (user_id, updated_at)
    currency_id
  }
}

Table categories {
  id uuid [pk]
  user_id uuid [ref: > users.id, note: 'null — системная категория']
  parent_id uuid [ref: > categories.id, note: 'Один уровень подкатегорий']
  type category_type [not null]
  key varchar(32) [note: 'Ключ системной категории: food, transport, market, shopping, subscriptions, fun, health, home, utilities, education, cafe, gifts / salary, transfer, business, sale, gift, freelance, cashback']
  name varchar(64) [note: 'Название своей категории; у системных — из category_translations']
  icon varchar(64) [not null, note: 'SF Symbol']
  color char(7) [not null]
  sort_order int [not null, default: 0]
  is_archived boolean [not null, default: false]
  created_at timestamptz [not null, default: `now()`]
  updated_at timestamptz [not null, default: `now()`]
  deleted_at timestamptz

  indexes {
    (user_id, type)
    (type, key)
    parent_id
  }
}

Table category_preferences {
  user_id uuid [not null, ref: > users.id]
  category_id uuid [not null, ref: > categories.id]
  sort_order int [not null]
  is_archived boolean [not null, default: false]
  updated_at timestamptz [not null, default: `now()`]

  Note: 'Порядок и скрытие системных категорий для конкретного пользователя; у своих категорий это поля самих categories'

  indexes {
    (user_id, category_id) [pk]
  }
}

Table category_translations {
  category_id uuid [not null, ref: > categories.id]
  language language_code [not null]
  label varchar(64) [not null]

  indexes {
    (category_id, language) [pk]
  }
}

Enum transaction_type {
  income
  expense
  transfer
}

Enum transaction_source {
  quick_add
  voice
  text_ai
  receipt_scan
  recurring
  siri
  widget
}

Table transactions {
  id uuid [pk, note: 'Генерируется на клиенте — офлайн-создание и идемпотентный синк']
  user_id uuid [not null, ref: > users.id]
  account_id uuid [not null, ref: > accounts.id, note: 'Для перевода — счёт списания']
  type transaction_type [not null]
  amount numeric(18,2) [not null, note: 'Всегда > 0, в валюте счёта; знак задаёт type']
  currency_id int [not null, ref: > currencies.id]
  amount_base numeric(18,2) [not null, note: 'Сумма в базовой валюте пользователя по курсу на дату операции']
  fx_rate numeric(20,10) [not null, default: 1]
  category_id uuid [ref: > categories.id, note: 'null для перевода']
  transfer_account_id uuid [ref: > accounts.id, note: 'Счёт зачисления для перевода']
  transfer_amount numeric(18,2) [note: 'Сумма зачисления в валюте второго счёта']
  note varchar(255)
  merchant varchar(128) [note: 'Из чека или AI-разбора']
  occurred_at timestamptz [not null]
  source transaction_source [not null, default: 'quick_add']
  recurring_rule_id uuid [ref: > recurring_rules.id]
  created_at timestamptz [not null, default: `now()`]
  updated_at timestamptz [not null, default: `now()`]
  deleted_at timestamptz

  indexes {
    (user_id, occurred_at)
    (user_id, type, occurred_at)
    (user_id, category_id, occurred_at)
    (user_id, updated_at)
    account_id
    currency_id
    category_id
    transfer_account_id
    recurring_rule_id
  }
}

Enum ocr_status {
  pending
  processing
  done
  failed
}

Table transaction_attachments {
  id uuid [pk]
  transaction_id uuid [not null, ref: > transactions.id]
  user_id uuid [not null, ref: > users.id]
  storage_key varchar(255) [not null]
  mime_type varchar(64) [not null]
  size_bytes int [not null]
  ocr_status ocr_status [not null, default: 'pending']
  ocr_payload jsonb [note: 'Распознанные сумма, дата, магазин, позиции']
  created_at timestamptz [not null, default: `now()`]

  indexes {
    transaction_id
    user_id
  }
}

// ---------- Регулярные платежи ----------

Enum recurrence_frequency {
  daily
  weekly
  monthly
  yearly
}

Table recurring_rules {
  id uuid [pk]
  user_id uuid [not null, ref: > users.id]
  account_id uuid [not null, ref: > accounts.id]
  category_id uuid [ref: > categories.id]
  type category_type [not null]
  title varchar(64) [not null, note: 'Netflix, Аренда, Зарплата']
  amount numeric(18,2) [not null]
  currency_id int [not null, ref: > currencies.id]
  frequency recurrence_frequency [not null]
  interval smallint [not null, default: 1, note: 'Каждые N периодов']
  day_of_month smallint [note: '31 — последний день месяца']
  weekday smallint
  start_on date [not null]
  end_on date
  next_run_on date [not null]
  auto_create boolean [not null, default: false, note: 'true — операция создаётся сама, false — только напоминание']
  remind_days_before smallint [not null, default: 1]
  is_subscription boolean [not null, default: false]
  is_active boolean [not null, default: true]
  created_at timestamptz [not null, default: `now()`]
  updated_at timestamptz [not null, default: `now()`]
  deleted_at timestamptz

  indexes {
    (is_active, next_run_on)
    (user_id, updated_at)
    account_id
    category_id
    currency_id
  }
}

// ---------- Бюджет ----------

Table budgets {
  id uuid [pk]
  user_id uuid [not null, ref: > users.id]
  period_start date [not null, note: 'Начало бюджетного месяца с учётом month_starts_on_day']
  period_end date [not null]
  currency_id int [not null, ref: > currencies.id, note: 'Базовая валюта на момент создания']
  planned_income numeric(18,2) [note: 'null — авто-режим по фактическим доходам']
  total_limit numeric(18,2) [note: 'Общий лимит расходов; null — без лимита']
  savings_target numeric(18,2) [not null, default: 0, note: 'Сколько планируется отложить в цели за месяц']
  rollover_enabled boolean [not null, default: false]
  rollover_amount numeric(18,2) [not null, default: 0, note: 'Перенесённый остаток прошлого месяца']
  created_at timestamptz [not null, default: `now()`]
  updated_at timestamptz [not null, default: `now()`]

  indexes {
    (user_id, period_start) [unique]
    currency_id
  }
}

Table budget_category_limits {
  id uuid [pk]
  budget_id uuid [not null, ref: > budgets.id]
  category_id uuid [not null, ref: > categories.id]
  limit_amount numeric(18,2) [not null]
  alert_threshold_pct smallint [not null, default: 80]

  indexes {
    (budget_id, category_id) [unique]
    category_id
  }
}

// ---------- Цели и накопления ----------

Enum goal_status {
  active
  paused
  completed
  archived
}

Table goals {
  id uuid [pk]
  user_id uuid [not null, ref: > users.id]
  title varchar(120) [not null]
  emoji varchar(8) [not null, default: '🎯']
  color char(7) [not null]
  cover_image_key varchar(255)
  template_key varchar(32) [note: 'phone, car, home, travel, education, emergency_fund, wedding, gadget']
  target_amount numeric(18,2) [not null]
  saved_amount numeric(18,2) [not null, default: 0, note: 'Кеш: сумма взносов минус снятия']
  currency_id int [not null, ref: > currencies.id]
  deadline date
  status goal_status [not null, default: 'active']
  is_primary boolean [not null, default: false, note: 'Не более одной основной цели на пользователя']
  priority int [not null, default: 0, note: 'Меньше — выше; меняется перетаскиванием']
  linked_account_id uuid [ref: > accounts.id, note: 'Счёт-копилка, куда физически откладываются деньги']
  completed_at timestamptz
  archived_at timestamptz
  created_at timestamptz [not null, default: `now()`]
  updated_at timestamptz [not null, default: `now()`]
  deleted_at timestamptz

  indexes {
    (user_id, status, priority)
    (user_id, updated_at)
    currency_id
    linked_account_id
  }
}

Enum contribution_type {
  deposit
  withdrawal
}

Enum contribution_method {
  manual
  smart_save
  auto_save
  round_up
}

Table goal_contributions {
  id uuid [pk]
  goal_id uuid [not null, ref: > goals.id]
  user_id uuid [not null, ref: > users.id]
  type contribution_type [not null]
  amount numeric(18,2) [not null, note: 'В валюте цели']
  currency_id int [not null, ref: > currencies.id]
  source_amount numeric(18,2) [note: 'Списано со счёта в его валюте']
  source_account_id uuid [ref: > accounts.id]
  method contribution_method [not null]
  auto_save_rule_id uuid [ref: > auto_save_rules.id]
  smart_save_suggestion_id uuid [unique, ref: - smart_save_suggestions.id]
  note varchar(255)
  created_at timestamptz [not null, default: `now()`]
  updated_at timestamptz [not null, default: `now()`, note: 'Меняется при отмене взноса — по нему синхронизация находит изменения']
  deleted_at timestamptz

  indexes {
    (goal_id, created_at)
    (user_id, created_at)
    (user_id, updated_at)
    currency_id
    source_account_id
    auto_save_rule_id
    smart_save_suggestion_id
  }
}

Table goal_milestones {
  goal_id uuid [not null, ref: > goals.id]
  percent smallint [not null, note: '25, 50, 75, 100']
  reached_at timestamptz [not null]

  indexes {
    (goal_id, percent) [pk]
  }
}

Enum auto_save_rule_type {
  fixed_schedule [note: 'Фиксированная сумма по расписанию']
  percent_of_income [note: 'Процент от каждого дохода']
  round_up [note: 'Округление каждого расхода']
}

Table auto_save_rules {
  id uuid [pk]
  user_id uuid [not null, ref: > users.id]
  goal_id uuid [not null, ref: > goals.id]
  type auto_save_rule_type [not null]
  amount numeric(18,2) [note: 'Для fixed_schedule, в валюте счёта-источника']
  percent numeric(5,2) [note: 'Для percent_of_income: доля каждого дохода на счёт-источник']
  round_to numeric(18,2) [note: 'Для round_up: 1000, 5000, 10000 — шаг в валюте счёта-источника, округляются расходы с него']
  frequency recurrence_frequency [note: 'Для fixed_schedule']
  weekday smallint
  day_of_month smallint
  source_account_id uuid [not null, ref: > accounts.id]
  next_run_on date
  is_active boolean [not null, default: true]
  created_at timestamptz [not null, default: `now()`]
  updated_at timestamptz [not null, default: `now()`]
  deleted_at timestamptz

  indexes {
    user_id
    goal_id
    source_account_id
  }
}

Enum suggestion_status {
  pending
  accepted
  declined
  expired
}

Table smart_save_suggestions {
  id uuid [pk, default: `gen_random_uuid()`]
  user_id uuid [not null, ref: > users.id]
  goal_id uuid [not null, ref: > goals.id]
  for_date date [not null, note: 'Одно принятое Smart Save в день']
  amount numeric(18,2) [not null, note: 'Предложенная сумма в валюте цели']
  amount_base numeric(18,2) [not null]
  accepted_amount numeric(18,2) [note: 'Пользователь может уменьшить сумму перед подтверждением']
  currency_id int [not null, ref: > currencies.id]
  safe_to_spend_today numeric(18,2) [not null]
  calculation jsonb [not null, note: 'Входные данные формулы для объяснения «почему такая сумма»']
  status suggestion_status [not null, default: 'pending']
  expires_at timestamptz [not null, note: 'Конец дня в часовом поясе пользователя']
  decided_at timestamptz
  created_at timestamptz [not null, default: `now()`]

  indexes {
    (user_id, for_date)
    goal_id
    currency_id
  }
}

// ---------- AI ----------

Enum insight_kind {
  daily_tip
  weekly_report
  monthly_report
  spending_analysis
  goal_analysis
  anomaly
  budget_forecast
}

Table ai_insights {
  id uuid [pk, default: `gen_random_uuid()`]
  user_id uuid [not null, ref: > users.id]
  kind insight_kind [not null]
  goal_id uuid [ref: > goals.id, note: 'Для goal_analysis']
  transaction_id uuid [ref: > transactions.id, note: 'Для anomaly']
  period_start date
  period_end date
  language language_code [not null]
  title varchar(160) [not null]
  summary text
  recommendation text
  score smallint [note: '0–100 для goal_analysis']
  payload jsonb [note: 'Цифры и данные для графиков']
  model varchar(64)
  read_at timestamptz
  created_at timestamptz [not null, default: `now()`]

  indexes {
    (user_id, kind, created_at)
    goal_id
    transaction_id
  }
}

Table ai_conversations {
  id uuid [pk]
  user_id uuid [not null, ref: > users.id]
  title varchar(160)
  created_at timestamptz [not null, default: `now()`]
  updated_at timestamptz [not null, default: `now()`]
  deleted_at timestamptz

  indexes {
    user_id
  }
}

Enum ai_message_role {
  user
  assistant
}

Table ai_messages {
  id uuid [pk]
  conversation_id uuid [not null, ref: > ai_conversations.id]
  role ai_message_role [not null]
  content text [not null]
  actions jsonb [note: 'Предложенные действия: создать цель, задать лимит — выполняются только после подтверждения']
  input_tokens int
  output_tokens int
  created_at timestamptz [not null, default: `now()`]

  indexes {
    (conversation_id, created_at)
  }
}

// ---------- Уведомления ----------

Enum notification_type {
  daily_reminder
  budget_threshold
  budget_exceeded
  goal_milestone
  goal_deadline
  recurring_due
  smart_save
  auto_save_done [note: 'Тихое: без звука, не чаще раза в день на правило']
  auto_save_skipped [note: 'На счёте не хватило денег — взнос пропущен']
  weekly_report
  insight
}

Enum notification_status {
  pending [note: 'Ждёт времени отправки или конца тихих часов']
  sent [note: 'Отправлено хотя бы на одно устройство']
  skipped [note: 'Не отправлено — причина в skip_reason']
}

Table notifications {
  id uuid [pk, default: `gen_random_uuid()`]
  user_id uuid [not null, ref: > users.id]
  type notification_type [not null]
  title varchar(160) [not null]
  body varchar(512) [not null]
  payload jsonb [note: 'Deep link и данные для действий из уведомления']
  dedupe_key varchar(128) [not null, unique, note: 'budget_threshold:{user}:{period}:{category}:80 — одно уведомление на событие']
  status notification_status [not null, default: 'pending']
  skip_reason varchar(32) [note: 'disabled, expired, not_needed, quiet_hours, daily_limit, no_device']
  scheduled_at timestamptz [not null, note: 'Сдвигается на конец тихих часов']
  expires_at timestamptz [not null, note: 'Позже не отправляется: устаревшее напоминание не нужно']
  sent_at timestamptz
  opened_at timestamptz
  created_at timestamptz [not null, default: `now()`]

  indexes {
    (user_id, created_at)
    (status, scheduled_at)
  }
}

// ---------- Lunex Pro и монетизация ----------

Enum subscription_source {
  trial [note: '30 дней Pro при первой регистрации']
  app_store
  promo [note: 'Выдано администратором']
}

Enum subscription_status {
  active
  grace_period [note: 'Проблема с оплатой, доступ сохраняется']
  expired
  revoked [note: 'Возврат средств или отзыв']
}

Table subscriptions {
  id uuid [pk, default: `gen_random_uuid()`]
  user_id uuid [not null, ref: > users.id]
  source subscription_source [not null]
  product_id varchar(64) [note: 'lunex.pro.monthly, lunex.pro.yearly; null для trial и promo']
  status subscription_status [not null, default: 'active']
  started_at timestamptz [not null]
  expires_at timestamptz [not null]
  auto_renew boolean [not null, default: false]
  original_transaction_id varchar(64) [unique, note: 'App Store original transaction id']
  environment varchar(16) [note: 'Production или Sandbox']
  created_at timestamptz [not null, default: `now()`]
  updated_at timestamptz [not null, default: `now()`]

  indexes {
    (user_id, expires_at)
  }
}

Table store_events {
  id uuid [pk, default: `gen_random_uuid()`]
  notification_uuid varchar(64) [not null, unique, note: 'App Store Server Notifications V2 — защита от повторной обработки']
  notification_type varchar(64) [not null]
  subtype varchar(64)
  original_transaction_id varchar(64)
  subscription_id uuid [ref: > subscriptions.id]
  signed_payload text [not null]
  processed_at timestamptz
  error text
  created_at timestamptz [not null, default: `now()`]

  indexes {
    subscription_id
  }
}

Enum ai_feature {
  assistant
  parse_input
  receipt
  insight
}

Table ai_usage_daily {
  user_id uuid [not null, ref: > users.id]
  usage_date date [not null, note: 'В часовом поясе пользователя']
  feature ai_feature [not null]
  requests int [not null, default: 0]
  input_tokens int [not null, default: 0]
  output_tokens int [not null, default: 0]

  indexes {
    (user_id, usage_date, feature) [pk]
  }
}

// ---------- Администрирование ----------

Table app_settings {
  key varchar(64) [pk, note: 'monetization_enabled, trial_days, ai_daily_limit_free, ai_daily_limit_pro, ai_daily_limit_parse, ai_daily_limit_receipt, free_max_accounts, free_max_goals, smart_save_share']
  value jsonb [not null]
  description varchar(255)
  updated_by uuid [ref: > users.id]
  updated_at timestamptz [not null, default: `now()`]

  indexes {
    updated_by
  }
}

Table admin_audit_log {
  id bigint [pk, increment]
  admin_id uuid [not null, ref: > users.id]
  action varchar(64) [not null, note: 'monetization.enable, monetization.disable, setting.update, subscription.grant']
  target varchar(128)
  old_value jsonb
  new_value jsonb
  created_at timestamptz [not null, default: `now()`]

  indexes {
    created_at
    admin_id
  }
}
```

## Integrations

- **Sign in with Apple** — вход через Apple ID
- **Google Sign-In (OAuth 2.0 / OIDC)** — вход через Google
- **Telegram Login** — вход через Telegram; бот-авторизатор без логики нужен только для проверки подписи
- **Почтовый сервис (Resend)** — одноразовые коды входа
- **StoreKit 2 и App Store Server API** — подписка Lunex Pro, проверка покупок и уведомления о подписках
- **APNs** — push-уведомления с действиями
- **ЦБ Узбекистана (cbu.uz)** — ежедневные курсы валют
- **Claude API** — AI-ассистент и отчёты (claude-sonnet-5-5), разбор голосового и текстового ввода и чеков (claude-haiku-5-5)
- **Apple Speech и VisionKit** — распознавание речи и чеков на устройстве
- **WidgetKit, App Intents, Siri, Shortcuts** — виджеты и голосовые команды
- **Объектное хранилище (S3-совместимое)** — фото чеков и обложки целей
- **Sentry** — сбои и производительность приложения и бэкенда
- **App Store Connect / TestFlight** — бета-тестирование и публикация

## Out of scope

- Telegram-бот и перенос его данных — бот полностью выключается, его код сохранён в `bot_old/` только для справки
- Вход по номеру телефона и SMS
- Android и веб-версия для пользователей
- Подключение банков и автоматический импорт выписок
- Совместные и семейные бюджеты
- Инвестиции, криптовалюта, учёт долгов и кредитов
- Версии для iPad и Apple Watch — в следующих релизах
- Хранение данных на серверах в Узбекистане (не требуется)

## Build plan

1. [x] Подготовка: код Telegram-бота перенесён в `bot_old/` и исключён из продукта
2. [x] Основа: дизайн-система (цвета, типографика, компоненты) и макеты ключевых экранов — вход, онбординг, главный, добавление, цели, бюджет, Lunex Pro
3. [x] Основа: проект NestJS — модули, конфигурация, Prisma, миграции и сиды (валюты, системные категории с переводами uz / ru / en, `app_settings`), Redis + BullMQ, Sentry
4. [x] Основа: авторизация в NestJS — Apple, Google, Telegram Login, код на почту, JWT и refresh-токены, связывание аккаунтов, устройства, удаление аккаунта
5. [x] Основа: каркас iOS 18 — навигация TabView, локализация, модели SwiftData, сетевой слой, Keychain, Sentry, загрузка удалённой конфигурации
6. [x] Основа: доступ к Pro — триал 30 дней при регистрации, проверка Pro и лимитов Free на сервере; при выключенной монетизации открыто всё
7. [x] MVP: экраны входа (Apple, Google, Telegram, почта) и онбординга, создание счёта «Наличные»
8. [x] MVP: счета и категории — CRUD на сервере и в приложении
9. [x] MVP: быстрое добавление операции, история с поиском и фильтрами, редактирование и удаление
10. [x] MVP: офлайн-очередь и инкрементальная синхронизация с локальной базой SwiftData, индикатор синхронизации
11. [x] MVP: расчёт бюджета в авто-режиме и «Можно потратить сегодня», экран бюджета
12. [x] MVP: цели — создание по шаблону, пополнение и снятие, основная цель, приоритет, этапы, достижение цели
13. [x] MVP: Smart Save — ежедневный расчёт на сервере (BullMQ), карточка с объяснением, подтверждение с пересчётом
14. [/] MVP: главный экран и чек-лист «Первые шаги»
15. [x] MVP: настройки, привязка способов входа, Face ID, скрытие сумм, размытие в переключателе приложений
16. [/] MVP: unit-тесты формул (дневной лимит, Smart Save, график цели, доступ к Pro), e2e-тесты API, UI-тесты ключевых сценариев, закрытая бета в TestFlight
17. [x] Рост: мастер бюджета с лимитами по категориям, перенос остатка, прогноз
18. [x] Рост: регулярные платежи и подписки, учёт в дневном лимите, поиск повторяющихся трат
19. [x] Рост: push-уведомления через APNs — напоминание, бюджет, цели, Smart Save с действиями, тихие часы
20. [x] Рост: мультивалютность — курсы ЦБ, переводы между счетами с курсом
21. [x] Рост: автонакопления — по расписанию, процент от дохода, округление
22. [x] Рост: аналитика на Swift Charts — категории, динамика, сравнение периодов, календарь трат
23. [/] Рост: виджеты домашнего экрана и экрана блокировки, App Intents и Siri, Пункт управления, быстрые действия
24. [x] AI: учёт расхода в `ai_usage_daily` и дневные лимиты Free / Pro
25. [x] AI: совет дня, недельный и месячный отчёты, анализ цели, аномалии, прогноз бюджета
26. [ ] AI: голосовой и текстовый ввод операций с AI-разбором
27. [ ] AI: сканирование чеков и вложения
28. [ ] AI: AI-ассистент — чат, ответы по данным, действия с подтверждением
29. [ ] Монетизация: продукты Lunex Pro в App Store Connect, экран Pro на StoreKit 2, восстановление покупок, App Store Server API и Notifications V2 — всё скрыто за флагом
30. [ ] Админка: веб-панель — справочники, параметры, кнопка включения монетизации с подтверждением, промо-доступ, журнал действий, мониторинг
31. [ ] Релиз: экспорт CSV / PDF, проверка доступности и тёмной темы
32. [ ] Релиз: публикация в App Store — скриншоты на трёх языках, политика конфиденциальности, App Privacy, ревью продуктов подписки
33. [ ] После релиза: включение монетизации кнопкой в админке, когда будет принято решение

## Open questions

- [ ] Утвердить разделение Free / Pro и лимиты Free (2 счета, 3 активные цели, 5 сообщений AI в день)
- [ ] Цены Lunex Pro за месяц и год; нужен ли пробный период App Store поверх собственного триала
- [ ] Что получают пользователи, у которых триал закончился до включения монетизации: сразу Free или дополнительные дни Pro (рекомендуется 14 дней с момента включения)?
- [ ] Почтовый сервис для кодов входа — Resend (рекомендуется) или AWS SES; домен отправителя

## Бизнес-правила

- **Суммы** хранятся положительными, знак задаёт тип операции; округление и отображение — по `decimals` валюты (UZS — без копеек).
- **Баланс счёта** = начальный баланс + доходы − расходы − исходящие переводы + входящие переводы (в валюте счёта). Правка операции меняет баланс на разницу, удаление отменяет её влияние, «Отменить» возвращает; повторная отправка той же операции не списывает деньги дважды.
- **Курс для операции** — последний на дату операции, не старше 7 дней (напрямую, обратный или через сум); если его нет, приложение передаёт курс или сумму зачисления само.
- **Баланс месяца** = доходы − расходы бюджетного месяца в базовой валюте; переводы между счетами на него не влияют, взносы в цели учитываются как «отложено», а не как расход.
- **Доступно на месяц** = (план дохода или факт дохода, берётся большее) + перенесённый остаток − цель накоплений месяца − расходы до сегодняшнего дня − предстоящие регулярные платежи до конца месяца.
- **Дневной лимит** = доступно на месяц ÷ число оставшихся дней, включая сегодня; если задан общий лимит, берётся меньшее из двух значений. **Можно потратить сегодня** = дневной лимит − расходы сегодня.
- **Smart Save**: сумма = 50 % (`smart_save_share`) от (баланс месяца − предстоящие платежи − уже отложенное в цели за месяц) ÷ оставшиеся дни, округлённая вниз до `rounding_step` (UZS — 1000). Сумма не больше остатка до цели и не больше баланса счёта. Если сумма меньше `min_smart_save` — статус «слишком мало». Цель — основная активная, иначе первая по приоритету. Принятие — не чаще раза в день. Без бюджета расчёт идёт по балансу месяца, как fallback в боте. Деньги берутся со счёта по умолчанию; сумма всегда округляется вниз, кроме случая, когда она ровно закрывает цель. Предложение готовится в 08:00 по времени пользователя (и при открытии карточки), действует до конца дня; при подтверждении сумма пересчитывается, и если она стала меньше выбранной, деньги не списываются, а показывается новая сумма.
- **Прогресс цели** = ⌊накоплено ÷ сумма × 100⌋. Когда накоплено ≥ суммы, цель автоматически становится «Достигнута» и новые пополнения не принимаются, пока цель не вернут в работу. Снятие не может превышать накопленное.
- **График цели**: нужный взнос = (сумма − накоплено) ÷ число оставшихся периодов до дедлайна (дни, недели, 30-дневные месяцы; округление вверх). Ожидаемое накопление — прямая от даты создания цели до дедлайна. «В графике» — отклонение от неё не больше 5 % суммы цели, меньше — «Отстаёт», больше — «Опережает»; после дедлайна — «Отстаёт».
- **Деньги цели**: пополнение списывает с выбранного счёта и зачисляет на счёт-копилку (если он есть; если деньги уже в копилке — только помечаются), снятие — наоборот. Копилка в валюте цели; счёт в другой валюте пересчитывается по курсу. Пустую цель можно удалить, цель с деньгами — только архивировать.
- **Достигнутая цель** принимает снятия (покупка того, на что копили), но не пополнения; в работу её возвращает пользователь или отмена пополнения, из-за которого накоплено стало меньше суммы.
- **Основная цель** у пользователя одна; если основную цель завершили или архивировали, основной становится следующая по приоритету.
- **Регулярные платежи**: день 29–31 в коротком месяце переносится на последний день; пропущенные из-за офлайна запуски досоздаются при синхронизации без дублей.
- **Часовой пояс** берётся с устройства пользователя (по умолчанию Asia/Tashkent); «сегодня» и «месяц» считаются в нём.
- **Уведомления** не повторяются для одного события (`dedupe_key`), соблюдают тихие часы и лимит 3 в день.
- **Доступ к Pro** есть, если монетизация выключена или у пользователя есть подписка (`subscriptions`) в статусе active или grace_period с `expires_at` в будущем. Триал создаётся один раз на пользователя при первой регистрации.
- **Лимиты Free** проверяет сервер при создании записи; приложение заранее показывает предложение Pro, но источником правды не является.
- **Лимит AI** считается по `ai_usage_daily` в часовом поясе пользователя и сбрасывается в полночь.
- **Связывание аккаунтов**: способ входа привязывается автоматически только по подтверждённой почте; Telegram почту не отдаёт, поэтому его привязывают вручную из настроек.

## Что меняется по сравнению с ботом

- Пятишаговый мастер операции → шторка с клавиатурой, 2–3 касания, голос и скан чека
- Операции нельзя было изменить или удалить → полная история с поиском, фильтрами и редактированием
- Одна валюта и нет счетов → несколько счетов, переводы, курсы ЦБ
- Бюджет только автоматический → авто-режим плюс лимиты по категориям, перенос остатка и прогноз
- Smart Save по кнопке → ежедневное предложение с объяснением, принимается из уведомления
- Цели только с ручным пополнением → снятие, пауза, этапы, график взносов, автонакопления и округление
- Insights из четырёх кнопок → интерактивная аналитика, отчёты, аномалии и AI-ассистент в чате
- Адаптивное меню → главный экран с цифрой «Можно потратить сегодня» и чек-листом первых шагов
- Только онлайн → офлайн-first с синхронизацией, виджеты, Siri, Face ID
- Регистрация по номеру телефона в боте → вход через Apple, Google, Telegram или почту
- JSON-RPC бэкенд бота → новый REST API на NestJS

## Решения

- **Бэкенд** — новый, на NestJS (TypeScript) с PostgreSQL; JSON-RPC сервис бота не используется.
- **Telegram-бот** полностью исключён и выключается, данные из него не переносятся; код сохранён в `bot_old/` только для справки.
- **Вход** — Apple, Google, Telegram (OAuth) и одноразовый код на почту; SMS и вход по номеру телефона не делаем.
- **Google** — OAuth 2.0 с PKCE в ASWebAuthenticationSession без SDK Google; приложение обменивает код на ID-токен и отдаёт его серверу.
- **Telegram** — Telegram возвращает только на домен бота, поэтому приложение открывает `/v1/auth/telegram/start` на сервере, а страница `/v1/auth/telegram/callback` передаёт результат в приложение (`lunex://auth/telegram`). Нужны `TELEGRAM_BOT_TOKEN` и `PUBLIC_URL` сервера (домен бота в @BotFather).
- **Доступные способы входа** приложение узнаёт из `GET /v1/auth/providers` и не открывает выключенный на сервере способ.
- **Синхронизация в приложении** — явная очередь операций (outbox) вместо истории изменений SwiftData: операция несёт намерение (создать, удалить, восстановить, пополнить цель) и свой opId, повторная отправка безопасна. Сначала отправляется очередь, потом загружаются изменения; отклонённое создание удаляет локальную запись, другие отказы запускают полную пересинхронизацию. При выходе из аккаунта локальная база очищается.
- **Бюджет в приложении** считается на устройстве по той же формуле, что и на сервере (тесты обеих сторон на одних и тех же примерах), из локальных операций и взносов: «Можно потратить сегодня» меняется сразу и без сети. То, чего на устройстве нет (план месяца, цель накоплений, перенос остатка, общий лимит, предстоящие регулярные платежи), приходит из `GET /v1/budget/current` и хранится до следующего обновления; план другого месяца или валюты не используется.
- **Идентификаторы** приложение присылает заглавными буквами (`UUID.uuidString`); сервер приводит каждый входящий UUID к нижнему регистру при разборе запроса, потому что сервисы сравнивают id как строки.
- **Главный экран по частям**: пункт «бюджет» чек-листа отмечается, когда экран бюджета открыт или задан план месяца; чек-лист можно скрыть. блок «Ближайшие платежи» — с регулярными платежами (шаг 18), голос на долгое нажатие «+» — с голосовым вводом (шаг 26); до тех пор долгое нажатие предлагает выбрать расход, доход или перевод.
- **План бюджета** задаётся мастером целиком (`PUT /v1/budget/current` или операция очереди `budget.set`, так что работает без сети; устройство сразу считает по новому плану и не заменяет его серверным, пока операция в очереди) и повторяется в следующих месяцах вместе с лимитами, пока его не изменят (план в старой базовой валюте не повторяется). Лимит категории включает её подкатегории и на дневной лимит не влияет; до порога (80 %) полоса обычная, после — песочная, с 100 % — красная. Подсказки мастера — средние за три прошлых бюджетных месяца с операциями (`GET /v1/budget/suggestions`): траты по категориям верхнего уровня округляются вверх до шага валюты, доход — вниз; цель накоплений подсказывается по тому, сколько нужно активным целям в месяц.
- **Перенос остатка** (Lunex Pro) — только реальные деньги прошлого месяца: фактический доход (не план) + перенесённое в него − отложенное в цели − расходы, не больше непотраченного общего лимита и не меньше нуля (перерасход не переносится). Сервер пересчитывает его при каждом чтении месяца, так что поздние правки прошлого месяца учитываются.
- **Регулярные платежи**: новое правило начинается с сегодняшнего дня (прошлые платежи уже идущей подписки не повторяются); день 29–31 в коротком месяце — последний день, месячное и годовое правило держит свой день (31 янв → 28 фев → 31 мар); расчёт запусков один на сервере и в приложении (`shared/formula-cases/recurrence.json`). Правило «записывать само» создаёт операции на сервере ежечасно и при каждой синхронизации, до «сегодня» в часовом поясе пользователя, в 09:00 дня запуска; id операции выводится из правила и дня, поэтому пропущенные запуски досоздаются без дублей; счёт, который удалён или в архиве, ставит правило на паузу. Правило-напоминание в день платежа ждёт «Записать» (операция сразу на устройстве, на сервер уходит `recurring.record`) или «Пропустить», оба сдвигают следующий запуск; push за N дней — в шаге 19. Предстоящие платежи для дневного лимита устройство считает по своим правилам, как сервер: запуски от сегодня до конца бюджетного месяца. Повторяющиеся траты ищет устройство (работает без сети): та же заметка или категория, сумма в пределах 10 %, день месяца в пределах 5 дней, не меньше 3 из последних 4 месяцев, последний — не старше 45 дней, ещё не оформленные правилом; скрытая подсказка больше не показывается.
- **Уведомления бюджета (80 % и 100 %)** делаются вместе с push в шаге 19; до тех пор порог виден по цвету полосы лимита.
- **Автонакопления** (Lunex Pro) — правила цели в разделе «Автонакопления» на её экране (это и есть `/goals/:id/auto-save`): фиксированная сумма каждый день, неделю (в выбранный день недели) или месяц (в выбранный день; 29–31 — последний день короткого месяца); процент от каждого дохода на счёт-источник; округление каждого расхода с этого счёта вверх до шага (1 000 / 5 000 / 10 000 сум; для других валют 1 / 5 / 10, для рубля и тенге 10 / 50 / 100). Суммы правила — в валюте счёта-источника, в цель — по курсу дня. Выполняет сервер: расписание — ежечасно с 09:00 по времени пользователя, один раз в день, пропущенные дни не копятся; процент и округление — сразу после операции (BullMQ). Id взноса выводится из правила и дня или операции, поэтому повтор не откладывает дважды. Взнос не больше остатка до цели; если на счёте не хватает денег — взнос пропускается и приходит уведомление; пока цель на паузе, правило ждёт, у достигнутой или архивной цели правило выключается. Тихое уведомление (без звука, вне лимита 3 в день) — одно в день на правило, чтобы округление не присылало push на каждую покупку. Правила синхронизируются своим потоком и меняются операциями очереди `autoSave.*`, поэтому редактируются без сети. Сервер отдаёт изменения через 5 секунд после записи (`SYNC_LAG_MS`), поэтому приложение после отправки очереди загружает изменения ещё раз через 7 секунд — взнос округления появляется сам.
- **Аналитика** — экран из бюджета (кнопка в панели и под карточками); считается на устройстве по локальным операциям в базовой валюте, поэтому работает без сети; сервер даёт только лимит Free (`limits.analyticsMonths`). Периоды: неделя (с первого дня недели из настроек), бюджетный месяц (с дня зарплаты) и календарный год; прошлый период — такой же перед ним. Категории — верхнего уровня (подкатегории входят в родителя), шесть крупнейших и «Другое»; переводы не считаются, взносы в цели — не расход. Касание сектора, строки или дня календаря открывает историю с фильтром по категории (или «без категории») и точным датам периода. Динамика: неделя — по дням, месяц — по дням или неделям, год — по неделям или месяцам; касание столбца показывает его цифры. Сравнение — процент к прошлому периоду по каждой категории, «новая», если раньше трат не было; цветом выделен только рост трат. Календарь — для недели и месяца, 4 уровня интенсивности по доле самого дорогого дня. Цели — накоплено по валютам (архивные цели тоже держат деньги) и прогресс каждой неархивной. Lunex Free видит текущий и прошлый бюджетный месяц (и недели, которые в них заходят); год и более ранние периоды — в Pro.
- **Виджеты** — расширение `LunexWidgets`: «Можно потратить сегодня» (маленький и средний с кнопками быстрого добавления; на экране блокировки — кольцо, строка и прямоугольник), основная цель (домашний экран и экран блокировки) и быстрое добавление. Виджеты не читают базу и не ходят в сеть: приложение после каждого сохранения в локальную базу, смены плана, языка или «глаза» пишет снимок (цифры сегодня и завтра, цель) в App Group `group.uz.lunex.finance` и перерисовывает виджеты, только если цифры изменились; завтрашние цифры позволяют виджету самому сменить день в полночь, более старый снимок просит открыть приложение. Текст виджетов — на языке приложения, скрытые суммы скрыты и там; выход из аккаунта стирает снимок. Пункт чек-листа «виджет» показывает инструкцию и отмечается, когда виджет стоит на экране (проверяется при каждом возврате в приложение).
- **Быстрое добавление снаружи** — кнопки виджетов, кнопка Пункта управления и кнопки «Действие» запускают `OpenQuickAddIntent`, он открывает приложение на шторке нужного вида (сумма вводится в приложении; та же ссылка `lunex://add/expense|income|transfer`). Быстрые действия на иконке — «Расход» и «Доход» на языке приложения; «Скан чека» добавится со сканированием чеков (шаг 27).
- **Siri и Shortcuts** — «Добавь расход / доход в Lunex» (сумму Siri спрашивает, категория и заметка необязательны; категории расходов дают фразы «Добавь расход на такси в Lunex») и «Сколько я могу потратить сегодня?» (ответ голосом и карточкой). Intents идут в процессе приложения (система запускает его в фоне): операция записывается со счёта по умолчанию через очередь, как из шторки (работает без сети, источник `siri`), а «можно потратить» считается из локальной базы. Ответы Siri — на языке системы, на котором она говорит.
- **AI-инсайты** — цифры считает сервер, Claude только излагает их на языке пользователя (функция `insight` в `ai_usage_daily`); без ключа или при нечитаемом ответе то же говорит шаблон сервера (в карточке «Посчитано по вашим цифрам»), так что инсайт никогда не ждёт AI. Совет дня бесплатный, делается при первом запросе за день и выбирает главное: нет дохода, перерасход сегодня, основная цель отстаёт, категория больше 35 % трат месяца, цель впереди, или просто сколько можно потратить. В Lunex Pro (`ai_reports`) ежечасная задача в час пользователя делает: недельный отчёт в воскресенье в 19:00 (семь дней против семи предыдущих), месячный — в день зарплаты в 10:00 (прошедший бюджетный месяц против позапрошлого), оба с push «еженедельный отчёт»; прогноз бюджета в 12:00, когда прошло 7 дней месяца и осталось не меньше 3 (траты в темпе месяца плюс предстоящие платежи против общего лимита, а без него — дохода за вычетом цели накоплений; один раз на месяц и вердикт, push — только когда месяц идёт к перерасходу). Аномалия (Pro) проверяется сразу после сохранения расхода: больше трёх медиан расходов категории за 90 дней, нужно не меньше 3 расходов в истории; push один раз, с удалением расхода инсайт исчезает из ленты. Анализ цели (Pro `goal_analysis`) — по кнопке на экране цели; оценка 0–100: со сроком — накопленное против ровного темпа (по графику 85, на пятую впереди и больше — 100, отставание пропорционально), без срока — 30 + 0,4 × прогресс + 10 за каждый из трёх последних месяцев со взносом, достигнутая — 100; в тот же день с теми же цифрами приходит тот же анализ. Id инсайта выводится из того, о чём он, поэтому задачи и повторы делают его один раз. В приложении: карточка «Совет дня» на главном экране ведёт в ленту (`/insights`) с точками непрочитанного и «Прочитать все»; карточка инсайта показывает текст и цифры (график по дням и категории для отчёта, трата против обычной, прогноз против плана); push открывает `lunex://insights/<id>`.
- **Тесты формул** — примеры дневного лимита, бюджетного месяца, прогресса и графика цели лежат в `shared/formula-cases/*.json` — одинаково в обоих репозиториях; их читают и тесты сервера (Vitest), и тесты приложения (Swift Testing), так что обе стороны проверяются на одних и тех же цифрах; изменение формулы меняет файлы в обоих. Smart Save и доступ к Pro считаются только на сервере и тестируются там. Сквозной e2e-тест проходит первый день пользователя запросами приложения: вход по почте, онбординг, очередь синхронизации, бюджет, Smart Save, отмена.
- **UI-тесты** (XCUITest) не требуют бэкенда: отладочная сборка с `LUNEX_UI_TEST` в окружении работает с `UITestServer` — сервером в памяти, который отвечает теми же типами, что декодирует приложение; база, Keychain и UserDefaults у тестов свои, настоящий вход в симуляторе не трогается. В Release-сборке этого кода нет.
- **Бета в TestFlight** собирается скриптом `scripts/beta.sh` репозитория приложения (номер сборки — число коммитов, выгрузка сразу в App Store Connect); Release без https-адреса API не собирается.
- **Репозитории**: бэкенд — `dream_saver_bot` (`backend/`, `deploy/`, `shared/`, `bot_old/`), iOS-приложение — отдельный репозиторий `lunex_app` (перенесён из `ios/` с историей). В обоих лежит AGENTS.md из Coddle.
- **Продакшн**: API — `https://api.lunex.my/v1` на общем сервере 79.132.143.211 под HestiaCP. Все проекты сервера работают на одном PostgreSQL и одном Redis (оба на `127.0.0.1`): у Lunex — база `lunex_db` со своей ролью (другим подключаться нельзя) и база 10 в Redis. API работает в Docker в `/home/lunex/app` в сети хоста и слушает только `127.0.0.1:3100`; nginx Hestia держит порты 80/443 для всех сайтов сервера и проксирует `api.lunex.my` с сертификатом Let's Encrypt (шаблон `deploy/hestia/`, домен пользователя `lunex`). `lunex.my` — сайт Hestia для будущих страниц (политика конфиденциальности и поддержка для App Store). Деплой — `deploy/deploy.sh` по SSH-ключу; `deploy/setup.sh` на сервере создаёт недостающее (секреты, базу и роль, домен и сертификат). Секреты живут только в `/home/lunex/app/.env`. Образ при старте применяет миграции и справочники; за прокси лимиты считаются по адресу клиента (`TRUST_PROXY`).
- **Вход по почте в продакшне** выключен (`EMAIL_PROVIDER=off`), пока не подключён почтовый сервис: сервер не предлагает его в `GET /v1/auth/providers` и отказывает в отправке кода (`provider_disabled`), как для Google и Telegram без настроек. Включается записью `EMAIL_PROVIDER=resend` с ключом и отправителем на домене lunex.my.
- **Дизайн** — монохромный и минималистичный: интерфейс в оттенках графита, действия чернильные; цвет только у данных (кольца, полосы, диаграммы). Палитра данных: #557A95 (основной), #B1A296, #5D5C61, #7395AE, #938E94; перерасход и ошибки — приглушённый красный #A8463C. Цвета системных категорий и цвета на выбор для счетов и своих категорий — десять приглушённых тонов этой палитры (добавлены #8A9BA8, #5F8A8B, #6E8B74, #C08B5C, #8C7B6B); красный перерасхода среди них нет. Шрифт — системный SF Pro, главная цифра экрана тонким начертанием. Дизайн-система «Lunex Finance» и макеты «Экраны Lunex» — артефакты Claude; в коде — `ios/Packages/LunexKit/Sources/LunexUI/Design/`.
- **Монетизация** — Lunex Pro готов в коде, но выключен; включается одной кнопкой в админке с подтверждением. Каждый новый пользователь получает 30 дней Pro при регистрации.
- **Локализация данных** в Узбекистане не требуется.
- **Минимальная iOS — 18**: те же устройства, что и у iOS 17 (iPhone XS / XR и новее), плюс история изменений SwiftData для синхронизации, `#Index` / `#Unique` и кнопки Пункта управления.
- **Лимит AI** есть: 5 сообщений ассистенту в день в Free и 50 в Pro; значения меняются в админке.
- **Учёт AI** — каждый запрос к Claude идёт через один сервис: сначала Pro (голосовой ввод и чеки), потом место в дневном лимите, потом модель, потом токены в `ai_usage_daily` (запросы, входные и выходные токены по пользователю, дню и функции; кешированный ввод считается вводом). Место занимается до вызова модели одним SQL-запросом, поэтому параллельные запросы не проходят сверх лимита; неудачный запрос место возвращает (`ai_failed` — «Повторить», `ai_unavailable` — на сервере нет ключа), а исчерпанный день отвечает `ai_limit_reached` с временем сброса (полночь пользователя). Кроме лимита ассистента — защита от злоупотреблений: 100 разборов голоса и текста (`ai_daily_limit_parse`) и 30 чеков (`ai_daily_limit_receipt`) в день; инсайты сервер делает сам, без лимита. Остаток дня — `GET /v1/ai/usage`; приложение показывает «Осталось N из M на сегодня» в аккаунте (в чате — в шаге 28). Ключ Claude — `ANTHROPIC_API_KEY` в `.env` сервера, модели — `CLAUDE_MODEL_SMART` / `CLAUDE_MODEL_FAST`.
- **iPad и Apple Watch** — после первого релиза.
- **Уведомления**: каждое событие хранится один раз (`dedupe_key`) со статусом доставки и причиной пропуска; при отправке проверяется переключатель типа, актуальность (операции за день уже есть, платёж уже записан, предложение уже решено), тихие часы и лимит 3 в день. Отложенное тихими часами уходит в их конец, если к тому времени не устареет. В лимит не входят вечернее напоминание и напоминания о платежах (их пользователь настроил сам); вечернее напоминание приходит в выбранное время и в тихие часы. Напоминания о платежах и дедлайнах — с 09:00 по времени пользователя; Smart Save — в 08:00. Пороги бюджета проверяются фоновой задачей через несколько секунд после изменения трат, один раз на пачку операций; ровно 100 % — «лимит исчерпан», больше — «превышен».
- **Push**: APNs по HTTP/2 с токеном провайдера из ключа `.p8` (`PUSH_PROVIDER=apns`); пока ключа нет — `log`, при разработке — `simulator` (`xcrun simctl push`). Сборки из Xcode получают sandbox-токены и ходят на локальный сервер, TestFlight и App Store — production-токены и `api.lunex.my`, поэтому окружение APNs задаётся на сервере. Когда сессия устройства заканчивается (выход, «Выйти на всех устройствах», вход другого аккаунта, удаление), токен устройства стирается.
- **Курсы ЦБ** загружаются в 00:10, 09:10 и 15:10 по Ташкенту и при старте сервера, пропущенные дни (до 10) догружаются; исправленный ЦБ курс обновляется (`exchange_rates.updated_at`). В приложение курсы приходят синхронизацией: при полной — за 40 дней, дальше только новые, так что пересчёт работает без сети. Курс дня сервер и приложение выбирают одинаково (общие примеры `shared/formula-cases/fx.json`); операция считается по UTC-дате своего времени. Общий баланс — по курсу ЦБ на сегодня (до первых курсов — по курсу последней операции в той валюте).
- **Перевод между валютами** показывает курс так, как его произносят: сколько дешёвой валюты за единицу дорогой («1 $ = 12 044,72 сум»), в какую бы сторону ни шли деньги. Курс ЦБ на дату перевода подставляется сам и меняется на свой; без курса ЦБ нужно ввести свой. На сервер уходит сумма зачисления (`transferAmount`); при правке курс восстанавливается из сумм (курс дня остаётся курсом дня).
- **e2e-тесты** работают на своей базе `lunex_e2e` рядом с базой разработки (создаётся, мигрируется и заполняется перед прогоном) и со своим префиксом очередей: запущенный dev-сервер, его задачи и загруженные им курсы ЦБ их не затрагивают.
- **Центр уведомлений** — колокольчик на главном экране: отправленные push и те, что задержал лимит, тихие часы или отсутствие устройства; касание открывает нужный экран. «Отложить» и «Записать» выполняются из уведомления без открытия приложения и отвечают тихим уведомлением («Отложено», «Записано», «Сумма изменилась» с теми же кнопками).

## Working with Coddle

- The spec: https://coddle.uz/studio/synetra/lunex-finance/lunex-finance-spec — `spec_read` before a step; `spec_tick` a plan step with `state: "doing"` when you start it, and a step or an acceptance criterion as soon as it is done; write new decisions into it with `spec_edit` (only the changed text).
- The schema: https://coddle.uz/studio/synetra/lunex-finance/lunex-finance-db — change it with `db_edit`, compare it with the code with `db_drift`, take migrations with `db_migration`.
- This project is a spec and a schema only: it has no architecture — do not design, write or simulate one.
- Export this file again with `spec_export` after the spec changes: run its `download.command` here rather than retyping the file.
