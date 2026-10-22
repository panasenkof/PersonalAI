# Выполнение по стадиям

- [x] Владелец утвердил художественный вид B+C сферы.
- [x] Зафиксированы правила неизменности и очередность 86–90.
- [x] Подготовлен HTML-прототип Home v0.3: empty/chat/thinking, клавиатура, attachments, 320–430dp. [Макет](../../../docs/prototypes/nebula-home-composition-v03.html). Voice/error как полнофункциональные UX-состояния и редактируемый Figma **ещё открыты** из-за лимита Starter.
- [ ] Получить подтверждение владельца **компоновки**, не повторно сферы.
- [ ] Выполнить UX-аудит текущего Android с 320/360/390/430 dp, Android controls и большими шрифтами.
- [ ] Отдельным PR расширить design-system и завести fallback/profiling для Nebula Home.
- [ ] Отдельным PR перенести Home с feature flag, сохранив voice, text-normalize, LLM, history, local memory.
- [ ] Android screenshots/FPS/TalkBack/keyboard и CI; далее Memory/Settings/Import по одному PR.

- [x] Зафиксирован порядок батарейного performance gate после интеграции основных нагружающих частей Home; короткие промежуточные проверки обязательны.
