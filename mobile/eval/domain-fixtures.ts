/**
 * Fictional acceptance dataset. All names, medical numbers, VINs, and URLs are
 * invented test fixtures. No real user's health/identity is recorded.
 * Queries are paired with a concrete typed retrieval phrase: these tests do
 * not claim that a live model can rewrite free-form Russian into the phrase.
 */
export type DomainCase={
 id:string; domain:"car"|"recipes"|"web"|"home"|"medical";
 title:string; body:string; q:string; phrase:string;
 scope:"standard"|"sensitive"; owner?:string; source?:string;
};
export const CASES:DomainCase[]=[
 // Vehicle: multiple vehicles, maintenance events, payment and warranty source
 {id:"car-oil-23",domain:"car",title:"ТО седан 2023",body:"Седан Кедр 2023: замена моторного масла, пробег 34000 км, мастерская Гранит.",q:"Когда меняли масло седана?",phrase:"Гранит",scope:"standard"},
 {id:"car-oil-25",domain:"car",title:"ТО седан 2025",body:"Седан Кедр 2025: замена моторного масла, пробег 62000 км, мастерская Вектор.",q:"Где проходило ТО в 2025?",phrase:"Вектор",scope:"standard"},
 {id:"car-brakes",domain:"car",title:"Акт ремонта тормозов",body:"Акт РТ-481: 2025-04-11 заменены задние колодки, гарантия на работу до 2026-04-11.",q:"Какая гарантия на колодки?",phrase:"РТ-481",scope:"sensitive"},
 {id:"car-clutch",domain:"car",title:"Наряд-заказ сцепление",body:"Заказ ЗК-725: ремонт сцепления фургона, приём 2026-02-03, выдача 2026-02-09, цена 28400 руб.",q:"Как долго ремонтировали сцепление?",phrase:"ЗК-725",scope:"sensitive"},
 {id:"car-diagnostic",domain:"car",title:"Диагностика подвески",body:"Акт ДГ-612: люфт шаровой опоры справа, рекомендована проверка после 1000 км; не отмечено как устранённое.",q:"Устранили ли люфт?",phrase:"ДГ-612",scope:"sensitive"},
 {id:"car-policy",domain:"car",title:"Страховой полис",body:"Полис ПЛ-349: срок ОСАГО с 2026-06-01 до 2027-05-31, автомобиль Кедр.",q:"Когда заканчивается ОСАГО?",phrase:"ПЛ-349",scope:"sensitive"},
 {id:"car-reg",domain:"car",title:"Свидетельство регистрации",body:"СТС СТ-119: вымышленный VIN XTESTCAR00000001, седан Кедр, год 2019.",q:"Какой VIN у автомобиля?",phrase:"СТ-119",scope:"sensitive"},
 {id:"car-receipt",domain:"car",title:"Чек шиномонтажа",body:"Чек ЧК-271: балансировка колёс 2026-03-20, оплачено 2400 руб.",q:"Сколько заплатили за балансировку?",phrase:"ЧК-271",scope:"sensitive"},
 {id:"car-battery",domain:"car",title:"Аккумулятор",body:"Квитанция АК-831: батарея 2025-09-12, гарантия 24 месяца от покупки.",q:"Когда закончится гарантия аккумулятора?",phrase:"АК-831",scope:"sensitive"},
 {id:"car-inspection",domain:"car",title:"Техосмотр автомобиля",body:"Карта ДК-426: технический осмотр 2025-12-17, зафиксированы показатели проверки.",q:"Когда проводили техосмотр?",phrase:"ДК-426",scope:"sensitive"},
 {id:"car-wipers",domain:"car",title:"Замена дворников",body:"Автомобиль Кедр: дворники меняли 2026-01-18, комплект Аква 65/45.",q:"Какие дворники установлены?",phrase:"Аква",scope:"standard"},
 {id:"car-tyres",domain:"car",title:"Летняя резина",body:"Шины Сфера 205/55 R16 хранятся в гараже, ячейка Т-4.",q:"Где летние шины?",phrase:"Сфера",scope:"standard"},
 {id:"car-lease",domain:"car",title:"Договор аренды гаража",body:"Гараж по договору ГР-492, оплачивается до 5 числа каждого месяца, договор до 2027-03-31.",q:"Когда платить за гараж?",phrase:"ГР-492",scope:"sensitive"},
 {id:"car-incident",domain:"car",title:"Страховой случай",body:"Дело СЛ-253: осмотр бампера 2025-11-05; окончательная дата выплаты не указана.",q:"Была ли выплата?",phrase:"СЛ-253",scope:"sensitive"},

 // Culinary originals, user variants and correction-ready recipes
 {id:"recipe-white",domain:"recipes",title:"Лазанья с бешамелем",body:"Соус бешамель: молоко, мука, мускатный орех; выпекать 35 минут при 185 градусах.",q:"Сколько выпекать лазанью?",phrase:"мускатный",scope:"standard"},
 {id:"recipe-tomato",domain:"recipes",title:"Лазанья с томатным соусом",body:"Вторая лазанья: томаты, базилик, фарш индейки; выпекать 40 минут при 180 градусах.",q:"Какой соус у варианта с индейкой?",phrase:"индейки",scope:"standard"},
 {id:"recipe-pancakes",domain:"recipes",title:"Оладьи без кефира",body:"Оладьи на ряженке: 200 мл ряженки, мука, сода; обжаривать по три минуты.",q:"Что нужно для оладий?",phrase:"ряженке",scope:"standard"},
 {id:"recipe-camembert",domain:"recipes",title:"Запечённый камамбер",body:"Камамбер с розмарином, чесноком и мёдом; 12 минут при 190 градусах.",q:"Как запекать камамбер?",phrase:"розмарином",scope:"standard"},
 {id:"recipe-soup",domain:"recipes",title:"Суп-пюре",body:"Тыквенный суп-пюре с зирой и кокосовым молоком, без сливок.",q:"Какая приправа в супе?",phrase:"зирой",scope:"standard"},
 {id:"recipe-pie",domain:"recipes",title:"Яблочный пирог",body:"Пирог с антоновкой и корицей: 160 г муки, 30 минут при 180 градусах.",q:"Какие яблоки для пирога?",phrase:"антоновкой",scope:"standard"},
 {id:"recipe-sauce",domain:"recipes",title:"Соус для голубцов",body:"Соус для голубцов: сметана, паприка, томатная паста; тушить 25 минут.",q:"Чем заливать голубцы?",phrase:"паприка",scope:"standard"},
 {id:"recipe-dumplings",domain:"recipes",title:"Вареники",body:"Вареники с картофелем и жареным луком; отваривать пять минут.",q:"С чем вареники?",phrase:"картофелем",scope:"standard"},
 {id:"recipe-bread",domain:"recipes",title:"Домашний хлеб",body:"Хлеб на закваске, расстойка 8 часов, выпечка в чугунной форме.",q:"Как долго расстаивается хлеб?",phrase:"расстойка",scope:"standard"},
 {id:"recipe-salad",domain:"recipes",title:"Салат с фасолью",body:"Салат с красной фасолью, кинзой и лаймом, без майонеза.",q:"Какая зелень в салате?",phrase:"кинзой",scope:"standard"},

 // Source snapshots / AI articles and general saved web knowledge
 {id:"web-llm",domain:"web",title:"Статья про LLM",body:"Снимок статьи от 2026-09-03: контекстное окно, токенизация, температура модели. Текст не гарантирует актуальности.",q:"Где заметка про токенизацию?",phrase:"токенизация",scope:"standard",source:"https://example.test/ai/llm"},
 {id:"web-rag",domain:"web",title:"Материал RAG",body:"Конспект RAG: retrieval, чанкинг, переранжирование и цитирование источников; сохранён 2026-08-21.",q:"Как работало переранжирование?",phrase:"переранжирование",scope:"standard",source:"https://example.test/ai/rag"},
 {id:"web-agent",domain:"web",title:"Агентные инструменты",body:"Статья об агентных инструментах: политики доступа, tool calling и контроль побочных действий.",q:"Что было про tool calling?",phrase:"побочных",scope:"standard",source:"https://example.test/ai/tools"},
 {id:"web-embed",domain:"web",title:"Локальные эмбеддинги",body:"Заметка: эмбеддинги изображений могут поддерживать поиск по содержимому, но модель на телефоне не подтверждена.",q:"Было ли что-то про эмбеддинги фото?",phrase:"эмбеддинги",scope:"standard",source:"https://example.test/ai/images"},
 {id:"web-security",domain:"web",title:"Prompt injection",body:"В статье о prompt injection описаны недоверенные документы и разграничение системных инструкций и данных.",q:"Что было про безопасность промптов?",phrase:"injection",scope:"standard",source:"https://example.test/ai/security"},
 {id:"web-climate",domain:"web",title:"Климатическая статья",body:"Конспект о муссонах и сезонном увлажнении; статья сохранена 2026-07-14.",q:"Где заметка про муссоны?",phrase:"муссонах",scope:"standard",source:"https://example.test/geography/climate"},
 {id:"web-garden",domain:"web",title:"Садоводство",body:"Статья про лаванду: дренаж, солнце и зимнее укрытие.",q:"Что было про лаванду?",phrase:"дренаж",scope:"standard",source:"https://example.test/garden/lavender"},
 {id:"web-git",domain:"web",title:"Git workflows",body:"Заметка про rebase, cherry-pick и обязательные проверки CI.",q:"Какие команды Git упоминались?",phrase:"cherry",scope:"standard",source:"https://example.test/dev/git"},
 {id:"web-photos",domain:"web",title:"Архивы фотографий",body:"Статья о EXIF и рисках геометаданных при отправке снимков.",q:"Где были данные EXIF?",phrase:"EXIF",scope:"standard",source:"https://example.test/photo/exif"},
 {id:"web-repair",domain:"web",title:"Ремонт техники",body:"Сохранена только ссылка о диагностике мультиметра, полный текст не загружался.",q:"Читали ли весь текст о мультиметре?",phrase:"мультиметра",scope:"standard",source:"https://example.test/repair/meter"},

 // Household objects: photos have originals, but visual model is not inferred
 {id:"home-passport-box",domain:"home",title:"Коробка для бумаг",body:"Синяя коробка с документами стоит в шкафу прихожей, верхняя левая полка.",q:"Где синяя коробка?",phrase:"прихожей",scope:"standard"},
 {id:"home-cables",domain:"home",title:"Запасные кабели",body:"Кабели HDMI и USB-C лежат в прозрачном контейнере под рабочим столом, фото контейнера приложено.",q:"Где лежат HDMI кабели?",phrase:"HDMI",scope:"standard"},
 {id:"home-drill",domain:"home",title:"Шуруповёрт",body:"Шуруповёрт Бирма хранится в кладовке, стеллаж Б, нижняя полка.",q:"Где шуруповёрт?",phrase:"Бирма",scope:"standard"},
 {id:"home-bulbs",domain:"home",title:"Запасные лампы",body:"Лампы E27 лежат в ящике М-7, в комнате справа от окна.",q:"Где лежат лампочки E27?",phrase:"М-7",scope:"standard"},
 {id:"home-sparekeys",domain:"home",title:"Запасные ключи",body:"Запасные ключи от дачи лежат в зелёном футляре внутри сейфа. Не публиковать это место.",q:"Где ключи от дачи?",phrase:"футляре",scope:"sensitive"},
 {id:"home-winter",domain:"home",title:"Зимние ботинки",body:"Зимние ботинки сложены в тканевый чехол на антресоли спальни.",q:"Где зимняя обувь?",phrase:"антресоли",scope:"standard"},
 {id:"home-tools",domain:"home",title:"Набор ключей",body:"Торцевые головки в красном кейсе на полке Г-2 гаража.",q:"Где торцевые головки?",phrase:"Г-2",scope:"standard"},
 {id:"home-camera",domain:"home",title:"Фотоаппарат",body:"Фотокамера Лотос с объективом хранится в рюкзаке под кроватью, фото рюкзака сохранено.",q:"Где фотоаппарат?",phrase:"Лотос",scope:"standard"},

 // Test-person-specific health evidence. These are NOT diagnoses or advice.
 {id:"med-me-cbc",domain:"medical",owner:"person-owner",title:"ОАК Алексей 2026",body:"Пациент Алексей, гемоглобин 142 г/л, лабораторный бланк ЛБ-101 от 2026-02-12; диагноз не указан.",q:"Какой гемоглобин у Алексея?",phrase:"ЛБ-101",scope:"sensitive"},
 {id:"med-me-chol",domain:"medical",owner:"person-owner",title:"Липиды Алексей 2026",body:"Пациент Алексей, общий холестерин 5.1 ммоль/л, бланк ЛБ-102 от 2026-03-01. Нет вывода врача.",q:"Какой холестерин у Алексея?",phrase:"ЛБ-102",scope:"sensitive"},
 {id:"med-me-echo",domain:"medical",owner:"person-owner",title:"Эхо Алексей",body:"Пациент Алексей, результат ЭхоКГ ЭХ-103 от 2026-04-10; заключение врача не загружено.",q:"Есть ли заключение ЭхоКГ?",phrase:"ЭХ-103",scope:"sensitive"},
 {id:"med-me-us",domain:"medical",owner:"person-owner",title:"УЗИ Алексей",body:"Пациент Алексей, УЗИ УЗ-104 от 2026-04-25, сохранён снимок, описание органов отсутствует.",q:"Есть ли описание УЗИ?",phrase:"УЗ-104",scope:"sensitive"},
 {id:"med-maria-cbc",domain:"medical",owner:"person-maria",title:"ОАК Мария 2026",body:"Пациент Мария, гемоглобин 126 г/л, бланк ЛБ-201 от 2026-02-08, вымышленный пример.",q:"Какой гемоглобин у Марии?",phrase:"ЛБ-201",scope:"sensitive"},
 {id:"med-maria-iron",domain:"medical",owner:"person-maria",title:"Ферритин Мария",body:"Пациент Мария, ферритин 34 мкг/л, бланк ЛБ-202 от 2026-03-19; референсы не загружены.",q:"Какой ферритин у Марии?",phrase:"ЛБ-202",scope:"sensitive"},
 {id:"med-maria-mri",domain:"medical",owner:"person-maria",title:"МРТ Мария",body:"Пациент Мария, МРТ МР-203 от 2026-06-02; сохранён файл обследования, текст заключения отсутствует.",q:"Известно ли заключение МРТ Марии?",phrase:"МР-203",scope:"sensitive"},
 {id:"med-maria-vit",domain:"medical",owner:"person-maria",title:"Витамин D Мария",body:"Пациент Мария, витамин D 31 нг/мл, бланк ЛБ-204 от 2026-06-08.",q:"Какой витамин D у Марии?",phrase:"ЛБ-204",scope:"sensitive"},
 {id:"med-dmitry-cbc",domain:"medical",owner:"person-dmitry",title:"ОАК Дмитрий",body:"Пациент Дмитрий, гемоглобин 155 г/л, бланк ЛБ-301 от 2026-01-12.",q:"Какой гемоглобин у Дмитрия?",phrase:"ЛБ-301",scope:"sensitive"},
 {id:"med-dmitry-glucose",domain:"medical",owner:"person-dmitry",title:"Глюкоза Дмитрий",body:"Пациент Дмитрий, глюкоза 5.3 ммоль/л, бланк ЛБ-302 от 2026-03-12; натощак не указано.",q:"Глюкоза Дмитрия натощак?",phrase:"ЛБ-302",scope:"sensitive"},
 {id:"med-dmitry-ecg",domain:"medical",owner:"person-dmitry",title:"ЭКГ Дмитрий",body:"Пациент Дмитрий, ЭКГ ЭК-303 от 2026-05-01; комментарий кардиолога не приложен.",q:"Каков комментарий по ЭКГ?",phrase:"ЭК-303",scope:"sensitive"},
 {id:"med-dmitry-us",domain:"medical",owner:"person-dmitry",title:"УЗИ Дмитрий",body:"Пациент Дмитрий, УЗИ УЗ-304 от 2026-07-21; дата есть, результаты измерений отсутствуют.",q:"Какие размеры по УЗИ?",phrase:"УЗ-304",scope:"sensitive"},
];
export const SYNTHETIC_ONLY=true;
