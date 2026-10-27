# C1/C2 приёмка памяти PersAI — 27.10.2026

**Единственная очередь:** PLAN.md §2. Здесь доказательства и классификация проверок, а не новый roadmap или этап №72/66.4.

## Автоматически проверяется
- №63а.1: #134/#141/#146/#151 — SQLCipher encrypted manifest, совместимость v1–v7, запись Android Share receipts, защита от неверного ключа, обрыва, нехватки места и потери строк. Jest edge-case/rollback и native Android SQLCipher build/emulator Maestro smoke. Mock >2 GiB и 100001 entity **не равен** настоящему многогигабайтному восстановлению.
- №66.2: #136/#143/#148 — длинный вопрос, структурные поля, observations, названия файлов, явные годы/отрицания и безопасные scope; SQLite FTS5 и русский синтетический eval.
- №45.1/77.1: #144/#147/#152 — read по ID+revision+cursor/проверка ACL, scoped list/count, честный offset и полное/неполное чтение; original PDF page/audio time не выдумывать.
- №66.3/60б/75: #149/#153/#155–#159/#161/#162 в main, CI PASS. Текущий PR: official OpenAI whisper-1 verbose_json real segment timestamps only after explicit approved audio upload, strict validation and exactly-one-request behavior, save per-original provider time in encrypted source segments; local Whisper and compatible providers retain plain text/unknown locators. Tests: valid times, malformed negative/overlap/out-of-duration, compatible fallback, no duplicate egress, SQLite locators and forged nonaudio rejection. CURRENT CI NOT VERIFIED until final head. Provider timestamps ≠ native alignment; native offline ASR/PDF locators and Android p95, SAF/kill/>2GiB remain PARTIAL. OpenAI docs timestamp availability only until 26.02.2027.
- Тест 10k на GitHub Ubuntu CI PASS: baseline run 40469641798 — rows 10000; pending 21 ms, vector status 127 ms, FTS search 67 ms, total 355 ms. После keyset (#149) run 40470300923 — pending 4 ms, vector status 138 ms, FTS search 52 ms, total 298 ms. Это **два отдельных прогона, не статистическое p95/надёжное сравнение скорости**. Это **Node SQLite**, не Android SQLCipher, p95/thermal/батарея не измерены.
- Каждый PR обязан иметь CI TypeScript/Jest/browser/native-release/Android emulator PASS **на точном SHA**, а каждый merge — проверку актуального дерева main.

## C2 открыто, пока не доказано
1. Реальный >2 GiB SQLCipher encrypted archive roundtrip, проверка SHA256 всех BLOB частей, kill/full-disk/SAF content:// с не сообщающим размер провайдером. Для legacy backup старые защитные пределы остаются; для нового формата они не являются глобальным потолком памяти. Нельзя выдавать 2 GiB mock admission за надёжную реальную миграцию.
2. Durable SQLite очередь изменившихся фрагментов с продолжением после lock/crash, manifest model weights/tokenizer/preprocessing, приоритет foreground, измерения Android 1k/10k. SQL keyset улучшает работу, но не означает возобновляемый job runner.
3. Evidence к PDF страницам и аудио-таймкодам после extraction №60б/75, исторические as-of/relations №72/66.4. Диапазон текста заметки не равен проверенной странице документа.
4. Качество мультиязычного semantic recall на устройстве и широкое coverage UI/agent; отдельные запреты приватных исходников остаются обязательными.

Это НЕ новый backlog. Пока C2 PARTIAL; запрещено переименовывать его в DONE только потому, что unit/native CI зелёный. Сохранить в PLAN.md §2 до отдельного решения владельца.

## Ручная проверка — максимум один короткий ролик
На **тестовом профиле или телефоне без ценных данных** создать запись с вымышленным текстом, приложить небольшой PDF или фото, сохранить через Android Share → Память, найти по длинному вопросу и открыть оригинал. Если имеется безопасный **отдельный пустой профиль**, показать восстановление заранее сделанного зашифрованного тестового backup, без удаления и перезаписи настоящей памяти. Иначе restore шаг пропустить.

Записывать одно MP4 только с вымышленным содержимым. Не показывать/присылать recovery code, личный медицинский архив, приватные данные, ключ приложения. Если интерфейс работает, видео необязательно, но физическое устройство тогда отмечается NOT VERIFIED. Тест на 2 GiB лучше выполнять на CI-устройстве и синтетическом архиве, не на личных записях.

## Очистка
Synthetic corpus — SQLite :memory: с close() в finally; в пользовательский SQLCipher и UI не добавлены QA-страницы, debug seed и тестовые записи. Очищать приложение после проверки не требуется. CI лог без личных данных с retention 7 суток, APK артефакт 3 суток. Постоянные regression tests не являются мусором и остаются.
