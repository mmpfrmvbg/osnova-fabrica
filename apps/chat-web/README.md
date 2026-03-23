# apps/chat-web — Осирис Android

Capacitor-приложение: WebView-оболочка над `www/index.html`,
подключается к HTTP-серверу ОСИРИСА.

## Установка на Android-устройство

### Через ADB (USB)

1. Включить режим разработчика на телефоне:
   Настройки → О телефоне → нажать 7 раз на "Номер сборки"
2. Настройки → Для разработчиков → USB-отладка: включить
3. Подключить телефон к компьютеру USB-кабелем
4. В PowerShell или Git Bash:

       adb devices
       # телефон должен появиться в списке (не "unauthorized")

       adb install apps/chat-web/release/jarvis.apk

5. На телефоне появится приложение **"Осирис"**

### Через файл (без ADB)

1. Скопировать `apps/chat-web/release/jarvis.apk` на телефон
   (USB / Telegram / Google Drive / любой удобный способ)
2. На телефоне: Настройки → Безопасность →
   "Установка приложений из неизвестных источников": включить
3. Открыть файл-менеджер → найти APK → нажать "Установить"

### После установки

1. На компьютере запустить backend:

       cd apps/osiris && npm run osiris:tunnel

2. Открыть **"Осирис"** на телефоне
3. Tunnel URL подхватится автоматически через `/server-url` —
   чат готов к работе

Если сервер не найден автоматически — приложение предложит ввести
адрес вручную (например `http://192.168.1.X:3000` для локальной сети).

---

## Пересборка APK

После изменений в `www/`:

    cd apps/chat-web
    npx cap sync android
    cd android && gradlew clean assembleDebug
    cp android/app/build/outputs/apk/debug/app-debug.apk release/jarvis.apk

**Важно:** использовать `gradlew clean` — без него Gradle может
использовать кэш и включить старую версию `www/` в APK.
