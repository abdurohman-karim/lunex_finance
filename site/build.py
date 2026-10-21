"""
The site lunex.my: a home page, the privacy policy and support in Uzbek, Russian and English,
built into public/ (static HTML, no JavaScript beyond picking a language).

    python3 site/build.py      # then deploy/site.sh puts public/ on the server
"""
from html import escape
from pathlib import Path

ROOT = Path(__file__).parent
OUT = ROOT / "public"
EMAIL = "support@lunex.my"
UPDATED = {"ru": "21 октября 2026 г.", "uz": "2026-yil 21-oktabr", "en": "October 21, 2026"}
LANGS = ["ru", "uz", "en"]
LANG_NAMES = {"ru": "Русский", "uz": "Oʻzbekcha", "en": "English"}

UI = {
    "ru": {"privacy": "Политика конфиденциальности", "support": "Поддержка", "home": "Главная",
           "updated": "Действует с", "soon": "Скоро в App Store", "contact": "Написать в поддержку"},
    "uz": {"privacy": "Maxfiylik siyosati", "support": "Yordam", "home": "Bosh sahifa",
           "updated": "Kuchga kirgan sana:", "soon": "Tez orada App Store doʻkonida", "contact": "Yordamga yozish"},
    "en": {"privacy": "Privacy Policy", "support": "Support", "home": "Home",
           "updated": "Effective", "soon": "Coming to the App Store", "contact": "Contact support"},
}

HOME = {
    "ru": {
        "title": "Lunex — личные финансы",
        "lead": "Сколько можно спокойно потратить сегодня — видно сразу.",
        "points": [
            "Операция записывается за 2–3 касания, голосом или по фото чека.",
            "Деньги сами откладываются в цели: Smart Save, автонакопления и округление.",
            "Бюджет считается без настройки, а лимиты по категориям — когда захотите.",
            "Работает без сети, на узбекском, русском и английском, с несколькими счетами и валютами.",
        ],
    },
    "uz": {
        "title": "Lunex — shaxsiy moliya",
        "lead": "Bugun bemalol qancha sarflash mumkinligi darhol koʻrinadi.",
        "points": [
            "Amal 2–3 bosishda, ovoz bilan yoki chek rasmi orqali yoziladi.",
            "Pul oʻzi maqsadlarga ajratiladi: Smart Save, avtojamgʻarma va yaxlitlash.",
            "Byudjet sozlashsiz hisoblanadi, toifa limitlari esa xohlaganingizda.",
            "Internetsiz, oʻzbek, rus va ingliz tillarida, bir nechta hisob va valyuta bilan ishlaydi.",
        ],
    },
    "en": {
        "title": "Lunex — personal finance",
        "lead": "See at once how much you can safely spend today.",
        "points": [
            "Record an operation in two or three taps, by voice or from a photo of a receipt.",
            "Money puts itself aside for your goals: Smart Save, auto-save and round-ups.",
            "A budget that works with no setup, and category limits when you want them.",
            "Works offline, in Uzbek, Russian and English, with several accounts and currencies.",
        ],
    },
}

# Each section: (heading, [paragraphs or ("list", [items])])
PRIVACY = {
    "ru": [
        ("Кто мы", [
            "Lunex Finance («Lunex», «мы») — приложение для личных финансов для iPhone. Здесь описано, какие данные приложение собирает, зачем, где они хранятся и как ими управлять. Вопросы о данных присылайте на {email}.",
        ]),
        ("Какие данные мы собираем", [
            ("list", [
                "Аккаунт: адрес почты, имя (если его передали Apple, Google или Telegram при входе), идентификатор способа входа, язык, базовая валюта и часовой пояс.",
                "Финансовые данные, которые вы вводите: счета и балансы, операции (суммы, категории, заметки, магазины), бюджеты, цели и взносы, регулярные платежи и правила автонакоплений.",
                "Фото чеков, которые вы прикрепляете к операциям, и прочитанный с них текст.",
                "Тексты, которые вы пишете или произносите для записи операции, и вопросы AI-ассистенту с его ответами. Речь распознаётся на самом iPhone — звук в Lunex не передаётся.",
                "Устройство: модель, версия iOS и приложения, токен push-уведомлений Apple, время последней синхронизации.",
                "Покупки: сведения App Store о подписке Lunex Pro (номер транзакции, срок, статус). Платёжные данные мы не получаем — оплату проводит Apple.",
                "Отчёты о сбоях без персональных данных.",
            ]),
            "Мы не собираем геопозицию, контакты и рекламные идентификаторы и не отслеживаем вас в других приложениях и на сайтах.",
        ]),
        ("Зачем", [
            "Только чтобы приложение работало: вход и синхронизация между вашими iPhone, расчёт бюджета и «Можно потратить сегодня», Smart Save и автонакопления, курсы валют, уведомления, отчёты и подсказки, проверка подписки и ответы поддержки. Мы не продаём данные, не показываем рекламу и не передаём данные для рекламы.",
        ]),
        ("AI-функции и Claude", [
            "Ассистент, разбор фраз, чтение неясных чеков на сервере и тексты отчётов работают с помощью Claude — модели компании Anthropic, PBC (США). Lunex отправляет в Claude только то, что нужно для конкретной задачи: текст фразы, фото чека, ваш вопрос и цифры ваших операций, бюджета и целей.",
            "Это происходит только после вашего явного разрешения в приложении. Разрешение можно отозвать в разделе «Настройки → AI»; без него в Claude ничего не отправляется: фразы разбирают правила, чеки читаются на iPhone, отчёты пишутся по шаблону, а ассистент недоступен. Anthropic обрабатывает эти данные по поручению Lunex и по своим условиям для коммерческого API не использует их для обучения моделей.",
        ]),
        ("Где хранятся данные и кто их обрабатывает", [
            "Данные хранятся на сервере в дата-центре Fornex Hosting в Германии и в защищённом хранилище на вашем iPhone. Мы передаём данные только этим обработчикам и только для работы приложения:",
            ("list", [
                "Fornex Hosting S.L. — сервер (Германия);",
                "Anthropic, PBC — AI-функции, только с вашего разрешения (США);",
                "Apple — вход через Apple, подписки App Store, push-уведомления;",
                "Google и Telegram — только если вы входите через них;",
                "Resend — отправка кодов входа на почту (США);",
                "Sentry (Functional Software, Inc.) — отчёты о сбоях без персональных данных (США).",
            ]),
            "Курсы валют приходят с сайта Центрального банка Узбекистана; ваши данные туда не передаются.",
        ]),
        ("Безопасность", [
            "Обмен с сервером идёт только по HTTPS. Ключи входа хранятся в Keychain, данные на iPhone — в защищённом хранилище; приложение можно закрыть Face ID или кодом. Доступ к серверу ограничен.",
        ]),
        ("Сколько хранятся данные", [
            "Пока у вас есть аккаунт. После удаления аккаунта все данные и фото чеков стираются через 30 дней; до этого вход восстанавливает аккаунт. Коды входа действуют 10 минут. Технические журналы сервера хранятся ограниченное время и не содержат финансовых данных.",
        ]),
        ("Ваши права", [
            ("list", [
                "Посмотреть и выгрузить все свои данные: «Настройки → Экспорт → Скачать архив» (ZIP с данными в JSON и фото чеков).",
                "Исправить: любую запись можно изменить в приложении.",
                "Удалить аккаунт: «Настройки → Аккаунт → Удалить аккаунт».",
                "Отозвать разрешение на AI: «Настройки → AI».",
                "Отключить уведомления: в настройках приложения или iOS.",
            ]),
            "С любым вопросом пишите на {email} — ответим в течение 30 дней.",
        ]),
        ("Дети", [
            "Lunex не предназначен для детей младше 13 лет, и мы сознательно не собираем их данные.",
        ]),
        ("Изменения", [
            "Если политика изменится, мы обновим эту страницу и дату вверху, а о существенных изменениях сообщим в приложении.",
        ]),
    ],
    "uz": [
        ("Biz kimmiz", [
            "Lunex Finance («Lunex», «biz») — iPhone uchun shaxsiy moliya ilovasi. Bu yerda ilova qanday maʼlumotlarni yigʻishi, nima uchun, ular qayerda saqlanishi va ularni qanday boshqarish mumkinligi yozilgan. Maʼlumotlar boʻyicha savollarni {email} manziliga yuboring.",
        ]),
        ("Qanday maʼlumotlarni yigʻamiz", [
            ("list", [
                "Hisob: pochta manzili, ism (agar kirishda Apple, Google yoki Telegram uni bergan boʻlsa), kirish usuli identifikatori, til, asosiy valyuta va vaqt mintaqasi.",
                "Siz kiritadigan moliyaviy maʼlumotlar: hisoblar va qoldiqlar, amallar (summalar, toifalar, izohlar, doʻkonlar), byudjetlar, maqsadlar va badallar, doimiy toʻlovlar va avtojamgʻarma qoidalari.",
                "Amallarga biriktirgan chek rasmlaringiz va ulardan oʻqilgan matn.",
                "Amalni yozish uchun yozgan yoki aytgan matnlaringiz hamda AI-yordamchiga savollaringiz va uning javoblari. Nutq iPhoneʼning oʻzida taniladi — ovoz Lunexʼga yuborilmaydi.",
                "Qurilma: model, iOS va ilova versiyasi, Apple push-bildirishnomalari tokeni, oxirgi sinxronlash vaqti.",
                "Xaridlar: Lunex Pro obunasi haqida App Store maʼlumotlari (tranzaksiya raqami, muddat, holat). Toʻlov maʼlumotlarini olmaymiz — toʻlovni Apple amalga oshiradi.",
                "Shaxsiy maʼlumotlarsiz nosozlik hisobotlari.",
            ]),
            "Biz joylashuv, kontaktlar va reklama identifikatorlarini yigʻmaymiz hamda sizni boshqa ilova va saytlarda kuzatmaymiz.",
        ]),
        ("Nima uchun", [
            "Faqat ilova ishlashi uchun: kirish va iPhoneʼlaringiz oʻrtasida sinxronlash, byudjet va «Bugun sarflash mumkin» hisobi, Smart Save va avtojamgʻarma, valyuta kurslari, bildirishnomalar, hisobot va maslahatlar, obunani tekshirish va yordam xizmati javoblari. Biz maʼlumotlarni sotmaymiz, reklama koʻrsatmaymiz va reklama uchun bermaymiz.",
        ]),
        ("AI funksiyalari va Claude", [
            "Yordamchi, iboralarni tahlil qilish, noaniq cheklarni serverda oʻqish va hisobot matnlari Anthropic, PBC (AQSh) kompaniyasining Claude modeli yordamida ishlaydi. Lunex Claudeʼga faqat aniq vazifa uchun kerakli maʼlumotni yuboradi: ibora matni, chek rasmi, savolingiz va amallaringiz, byudjet hamda maqsadlaringiz raqamlari.",
            "Bu faqat ilovada aniq ruxsat berganingizdan keyin amalga oshadi. Ruxsatni «Sozlamalar → AI» boʻlimida bekor qilish mumkin; usiz Claudeʼga hech narsa yuborilmaydi: iboralarni qoidalar tahlil qiladi, cheklar iPhoneʼda oʻqiladi, hisobotlar shablon boʻyicha yoziladi, yordamchi esa ishlamaydi. Anthropic bu maʼlumotlarni Lunex topshirigʻi bilan qayta ishlaydi va tijorat API shartlariga koʻra ular asosida modellarini oʻqitmaydi.",
        ]),
        ("Maʼlumotlar qayerda saqlanadi va kim qayta ishlaydi", [
            "Maʼlumotlar Germaniyadagi Fornex Hosting maʼlumotlar markazidagi serverda va iPhoneʼingizdagi himoyalangan xotirada saqlanadi. Maʼlumotlarni faqat quyidagi ijrochilarga va faqat ilova ishlashi uchun beramiz:",
            ("list", [
                "Fornex Hosting S.L. — server (Germaniya);",
                "Anthropic, PBC — AI funksiyalari, faqat ruxsatingiz bilan (AQSh);",
                "Apple — Apple orqali kirish, App Store obunalari, push-bildirishnomalar;",
                "Google va Telegram — faqat ular orqali kirsangiz;",
                "Resend — pochtaga kirish kodlarini yuborish (AQSh);",
                "Sentry (Functional Software, Inc.) — shaxsiy maʼlumotlarsiz nosozlik hisobotlari (AQSh).",
            ]),
            "Valyuta kurslari Oʻzbekiston Markaziy banki saytidan olinadi; maʼlumotlaringiz u yerga yuborilmaydi.",
        ]),
        ("Xavfsizlik", [
            "Server bilan almashinuv faqat HTTPS orqali boʻladi. Kirish kalitlari Keychainʼda, iPhoneʼdagi maʼlumotlar himoyalangan xotirada saqlanadi; ilovani Face ID yoki kod bilan qulflash mumkin. Serverga kirish cheklangan.",
        ]),
        ("Maʼlumotlar qancha saqlanadi", [
            "Hisobingiz mavjud ekan. Hisob oʻchirilgach, barcha maʼlumotlar va chek rasmlari 30 kundan keyin oʻchiriladi; bungacha qayta kirish hisobni tiklaydi. Kirish kodlari 10 daqiqa amal qiladi. Serverning texnik jurnallari cheklangan muddat saqlanadi va moliyaviy maʼlumotlarni oʻz ichiga olmaydi.",
        ]),
        ("Sizning huquqlaringiz", [
            ("list", [
                "Barcha maʼlumotlaringizni koʻrish va yuklab olish: «Sozlamalar → Eksport → Arxivni yuklab olish» (JSON maʼlumotlar va chek rasmlari bilan ZIP).",
                "Tuzatish: istalgan yozuvni ilovada oʻzgartirish mumkin.",
                "Hisobni oʻchirish: «Sozlamalar → Hisob → Hisobni oʻchirish».",
                "AI ruxsatini bekor qilish: «Sozlamalar → AI».",
                "Bildirishnomalarni oʻchirish: ilova yoki iOS sozlamalarida.",
            ]),
            "Har qanday savol bilan {email} manziliga yozing — 30 kun ichida javob beramiz.",
        ]),
        ("Bolalar", [
            "Lunex 13 yoshgacha boʻlgan bolalar uchun moʻljallanmagan va biz ularning maʼlumotlarini ataylab yigʻmaymiz.",
        ]),
        ("Oʻzgarishlar", [
            "Siyosat oʻzgarsa, ushbu sahifani va yuqoridagi sanani yangilaymiz, muhim oʻzgarishlar haqida esa ilovada xabar beramiz.",
        ]),
    ],
    "en": [
        ("Who we are", [
            "Lunex Finance (“Lunex”, “we”) is a personal finance app for iPhone. This policy explains what data the app collects, why, where it is kept and how you control it. Send questions about your data to {email}.",
        ]),
        ("What we collect", [
            ("list", [
                "Account: email address, name (if Apple, Google or Telegram gave it at sign-in), the id of the sign-in method, language, base currency and time zone.",
                "The financial data you enter: accounts and balances, operations (amounts, categories, notes, shops), budgets, goals and contributions, recurring payments and auto-save rules.",
                "Photos of receipts you attach to operations, and the text read from them.",
                "Text you type or say to record an operation, and your questions to the AI assistant with its answers. Speech is recognized on the iPhone itself — no audio reaches Lunex.",
                "Device: model, iOS and app version, Apple push notification token, time of the last sync.",
                "Purchases: App Store details of the Lunex Pro subscription (transaction number, term, status). We never get payment details — Apple takes the payment.",
                "Crash reports without personal data.",
            ]),
            "We do not collect location, contacts or advertising identifiers, and we do not track you across other apps or websites.",
        ]),
        ("Why", [
            "Only to run the app: signing in and syncing between your iPhones, the budget and “Safe to spend today”, Smart Save and auto-save, exchange rates, notifications, reports and tips, checking the subscription and answering support requests. We do not sell data, show ads or share data for advertising.",
        ]),
        ("AI features and Claude", [
            "The assistant, reading phrases, reading unclear receipts on the server and the words of reports work with Claude, a model by Anthropic, PBC (USA). Lunex sends Claude only what a task needs: the phrase, the receipt photo, your question and the figures of your operations, budget and goals.",
            "This happens only after you explicitly allow it in the app. You can take the permission back in Settings → AI; without it nothing goes to Claude: phrases are read by rules, receipts on the iPhone, reports come from templates and the assistant is off. Anthropic processes this data on Lunex's behalf and, under its commercial API terms, does not train its models on it.",
        ]),
        ("Where data is kept and who processes it", [
            "Data is kept on a server in Fornex Hosting's data center in Germany and in protected storage on your iPhone. We share data only with these processors and only to run the app:",
            ("list", [
                "Fornex Hosting S.L. — the server (Germany);",
                "Anthropic, PBC — AI features, only with your permission (USA);",
                "Apple — Sign in with Apple, App Store subscriptions, push notifications;",
                "Google and Telegram — only if you sign in with them;",
                "Resend — sending sign-in codes by email (USA);",
                "Sentry (Functional Software, Inc.) — crash reports without personal data (USA).",
            ]),
            "Exchange rates come from the website of the Central Bank of Uzbekistan; none of your data is sent there.",
        ]),
        ("Security", [
            "The app talks to the server over HTTPS only. Sign-in keys are kept in the Keychain and data on the iPhone in protected storage; the app can be locked with Face ID or a passcode. Access to the server is restricted.",
        ]),
        ("How long data is kept", [
            "For as long as you have an account. When you delete it, all data and receipt photos are erased after 30 days; signing in before then restores the account. Sign-in codes last 10 minutes. Technical server logs are kept for a limited time and hold no financial data.",
        ]),
        ("Your rights", [
            ("list", [
                "See and download all your data: Settings → Export → Download archive (a ZIP with your data as JSON and the receipt photos).",
                "Correct it: any record can be changed in the app.",
                "Delete your account: Settings → Account → Delete account.",
                "Take back the AI permission: Settings → AI.",
                "Turn notifications off: in the app's settings or in iOS.",
            ]),
            "Write to {email} with any question — we answer within 30 days.",
        ]),
        ("Children", [
            "Lunex is not meant for children under 13, and we do not knowingly collect their data.",
        ]),
        ("Changes", [
            "If this policy changes, we will update this page and the date above, and tell you in the app about significant changes.",
        ]),
    ],
}

SUPPORT = {
    "ru": [
        ("Напишите нам", [
            "{email} — обычно отвечаем в течение двух рабочих дней. Укажите почту аккаунта и опишите, что произошло; скриншот помогает.",
        ]),
        ("Как войти?", ["Через Apple, Google, Telegram или код на почту — на экране входа видны способы, которые сейчас работают. Пароль не нужен."]),
        ("Как увидеть данные на другом iPhone?", ["Войдите тем же способом — счета, операции, цели и настройки синхронизируются."]),
        ("Как выгрузить данные?", ["«Настройки → Экспорт»: таблица CSV или PDF-отчёт за выбранный период (Lunex Pro) и архив всех данных аккаунта (бесплатно)."]),
        ("Как удалить аккаунт?", ["«Настройки → Аккаунт → Удалить аккаунт». Данные стираются через 30 дней; если войти раньше, аккаунт восстановится."]),
        ("Что такое разрешение на AI?", ["Ассистент, разбор фраз, чтение неясных чеков и тексты отчётов используют Claude от Anthropic. Lunex отправляет туда данные только с вашего разрешения; включить или отозвать его можно в «Настройки → AI»."]),
        ("Подписка Lunex Pro", ["Сейчас все функции Lunex бесплатны. Когда появится подписка, управлять ею и отменить её можно в «Настройки iPhone → Apple ID → Подписки», а «Восстановить покупки» — на экране Lunex Pro. Вернуть деньги можно через reportaproblem.apple.com."]),
    ],
    "uz": [
        ("Bizga yozing", [
            "{email} — odatda ikki ish kuni ichida javob beramiz. Hisob pochtasini koʻrsating va nima boʻlganini yozing; skrinshot yordam beradi.",
        ]),
        ("Qanday kirish mumkin?", ["Apple, Google, Telegram yoki pochtaga keladigan kod orqali — kirish ekranida hozir ishlayotgan usullar koʻrinadi. Parol kerak emas."]),
        ("Maʼlumotlarni boshqa iPhoneʼda qanday koʻrish mumkin?", ["Xuddi shu usul bilan kiring — hisoblar, amallar, maqsadlar va sozlamalar sinxronlanadi."]),
        ("Maʼlumotlarni qanday yuklab olish mumkin?", ["«Sozlamalar → Eksport»: tanlangan davr uchun CSV jadval yoki PDF hisobot (Lunex Pro) va hisobning barcha maʼlumotlari arxivi (bepul)."]),
        ("Hisobni qanday oʻchirish mumkin?", ["«Sozlamalar → Hisob → Hisobni oʻchirish». Maʼlumotlar 30 kundan keyin oʻchiriladi; bungacha kirsangiz, hisob tiklanadi."]),
        ("AI ruxsati nima?", ["Yordamchi, iboralarni tahlil qilish, noaniq cheklarni oʻqish va hisobot matnlari Anthropic kompaniyasining Claude modelidan foydalanadi. Lunex maʼlumotlarni u yerga faqat ruxsatingiz bilan yuboradi; uni «Sozlamalar → AI» boʻlimida yoqish yoki bekor qilish mumkin."]),
        ("Lunex Pro obunasi", ["Hozircha Lunexʼning barcha funksiyalari bepul. Obuna paydo boʻlgach, uni «iPhone sozlamalari → Apple ID → Obunalar» boʻlimida boshqarish va bekor qilish, «Xaridlarni tiklash»ni esa Lunex Pro ekranida bajarish mumkin. Pulni reportaproblem.apple.com orqali qaytarish mumkin."]),
    ],
    "en": [
        ("Write to us", [
            "{email} — we usually answer within two business days. Include the email of your account and what happened; a screenshot helps.",
        ]),
        ("How do I sign in?", ["With Apple, Google, Telegram or a code sent to your email — the sign-in screen shows the methods that work right now. No password needed."]),
        ("How do I see my data on another iPhone?", ["Sign in the same way — accounts, operations, goals and settings sync."]),
        ("How do I export my data?", ["Settings → Export: a CSV table or a PDF report for a chosen period (Lunex Pro), and an archive of all account data (free)."]),
        ("How do I delete my account?", ["Settings → Account → Delete account. Data is erased after 30 days; signing in before then restores the account."]),
        ("What is the AI permission?", ["The assistant, reading phrases, reading unclear receipts and the words of reports use Claude by Anthropic. Lunex sends data there only with your permission; turn it on or off in Settings → AI."]),
        ("Lunex Pro subscription", ["For now every feature of Lunex is free. Once the subscription arrives, manage or cancel it in iPhone Settings → Apple ID → Subscriptions, and use “Restore purchases” on the Lunex Pro screen. Refunds go through reportaproblem.apple.com."]),
    ],
}

TITLES = {
    "privacy": {"ru": "Политика конфиденциальности Lunex", "uz": "Lunex maxfiylik siyosati", "en": "Lunex Privacy Policy"},
    "support": {"ru": "Поддержка Lunex", "uz": "Lunex yordam xizmati", "en": "Lunex Support"},
}


def text(value: str) -> str:
    """Escaped, with the support address as a link."""
    link = f'<a href="mailto:{EMAIL}">{EMAIL}</a>'
    return escape(value).replace(escape("{email}"), link)


def page(lang: str, path: str, title: str, body: str, description: str) -> str:
    current = ' aria-current="page"'
    switch = " ".join(
        f'<a href="/{code}/{path}" lang="{code}"{current if code == lang else ""}>{LANG_NAMES[code]}</a>'
        for code in LANGS
    )
    nav = (
        f'<a href="/{lang}/">{UI[lang]["home"]}</a>'
        f'<a href="/{lang}/privacy/">{UI[lang]["privacy"]}</a>'
        f'<a href="/{lang}/support/">{UI[lang]["support"]}</a>'
    )
    alternates = "\n".join(
        f'    <link rel="alternate" hreflang="{code}" href="https://lunex.my/{code}/{path}" />' for code in LANGS
    )
    return f"""<!doctype html>
<html lang="{lang}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{escape(title)}</title>
    <meta name="description" content="{escape(description)}" />
{alternates}
    <link rel="stylesheet" href="/assets/site.css" />
  </head>
  <body>
    <header>
      <a class="brand" href="/{lang}/">Lunex</a>
      <nav aria-label="Lunex">{nav}</nav>
    </header>
    <main>
{body}
    </main>
    <footer>
      <nav aria-label="Language">{switch}</nav>
      <p><a href="mailto:{EMAIL}">{EMAIL}</a></p>
    </footer>
  </body>
</html>
"""


def sections(items) -> str:
    out = []
    for heading, parts in items:
        out.append(f"      <section>\n        <h2>{escape(heading)}</h2>")
        for part in parts:
            if isinstance(part, tuple):
                rows = "".join(f"<li>{text(item)}</li>" for item in part[1])
                out.append(f"        <ul>{rows}</ul>")
            else:
                out.append(f"        <p>{text(part)}</p>")
        out.append("      </section>")
    return "\n".join(out)


def write(path: str, html: str) -> None:
    target = OUT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(html, encoding="utf-8")


def language_picker(path: str) -> str:
    """/privacy/ and friends: the visitor's language if we have it, Russian otherwise."""
    links = "".join(f'<li><a href="/{code}/{path}">{LANG_NAMES[code]}</a></li>' for code in LANGS)
    return f"""<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Lunex</title>
    <link rel="stylesheet" href="/assets/site.css" />
    <script>
      (function () {{
        var langs = (navigator.languages || [navigator.language || "ru"]).map(function (l) {{ return l.slice(0, 2); }});
        var pick = langs.find(function (l) {{ return l === "uz" || l === "ru" || l === "en"; }}) || "ru";
        location.replace("/" + pick + "/{path}");
      }})();
    </script>
  </head>
  <body>
    <main><ul class="languages">{links}</ul></main>
  </body>
</html>
"""


def build() -> None:
    for lang in LANGS:
        home = HOME[lang]
        points = "".join(f"<li>{escape(point)}</li>" for point in home["points"])
        body = f"""      <h1>{escape(home["title"])}</h1>
      <p class="lead">{escape(home["lead"])}</p>
      <ul class="points">{points}</ul>
      <p class="soon">{escape(UI[lang]["soon"])}</p>
      <p><a class="button" href="mailto:{EMAIL}">{escape(UI[lang]["contact"])}</a></p>"""
        write(f"{lang}/index.html", page(lang, "", home["title"], body, home["lead"]))

        title = TITLES["privacy"][lang]
        body = f"""      <h1>{escape(title)}</h1>
      <p class="updated">{escape(UI[lang]["updated"])} {escape(UPDATED[lang])}</p>
{sections(PRIVACY[lang])}"""
        write(f"{lang}/privacy/index.html", page(lang, "privacy/", title, body, title))

        title = TITLES["support"][lang]
        body = f"""      <h1>{escape(title)}</h1>
{sections(SUPPORT[lang])}"""
        write(f"{lang}/support/index.html", page(lang, "support/", title, body, title))

    write("index.html", language_picker(""))
    write("privacy/index.html", language_picker("privacy/"))
    write("support/index.html", language_picker("support/"))
    write("robots.txt", "User-agent: *\nAllow: /\n")
    (OUT / "assets").mkdir(parents=True, exist_ok=True)
    (OUT / "assets" / "site.css").write_text((ROOT / "site.css").read_text(encoding="utf-8"), encoding="utf-8")


if __name__ == "__main__":
    build()
    print("built", sum(1 for _ in OUT.rglob("*.html")), "pages into", OUT)
