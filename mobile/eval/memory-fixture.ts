/** Проверочный набор поиска по памяти (п. 8 плана).
 *
 * Память вымышленного пользователя Ивана и вопросы к ней. У каждого вопроса —
 * записи, которые должны оказаться среди пяти найденных. Набор меряет, насколько
 * гибко помощник находит сведения о пользователе, и не даёт ухудшить поиск
 * незаметно. Свои вопросы можно добавить сюда же: id записи + ожидание. */

import type { SectionSlug } from "../src/local-memory/sections";

export type EvalNote = { id: string; section: SectionSlug; title: string; body: string };
export type EvalCategory =
  | "forms"     // другая форма того же слова: «машину» → «машина»
  | "synonyms"  // синоним или родственное слово: «автомобиль» → «машина»
  | "person"    // через человека: «что любит сестра» → записи Ани, где слова «сестра» нет
  | "meaning"   // по смыслу без общих слов: «чем угостить Аню» → «любит кофе»
  | "absent"    // ответа в памяти нет: помощник должен сказать это и искать в интернете
  | "private";  // спрашивают о личном разделе: его записи модели не уходят никогда
export type EvalQuestion = { q: string; category: EvalCategory; expect: string[] };

export const EVAL_NOTES: EvalNote[] = [
  { id: "me-name", section: "about", title: "Имя", body: "Меня зовут Иван Петров, обращаться на «ты»." },
  { id: "me-city", section: "about", title: "Город", body: "Живу в Ростове-на-Дону, район Западный." },
  { id: "me-job", section: "about", title: "Работа", body: "Руковожу продуктом в компании «Север-Софт», делаем кассовые программы для магазинов." },
  { id: "me-car", section: "about", title: "Машина", body: "Езжу на Шкоде Октавии 2019 года, серый цвет." },
  { id: "anya-who", section: "people", title: "Аня", body: "Аня — моя младшая сестра, живёт в Москве." },
  { id: "anya-likes", section: "people", title: "Что любит Аня", body: "Аня обожает капучино и кошек, не любит громкую музыку." },
  { id: "oleg-who", section: "people", title: "Олег", body: "Олег — мой старший брат, живёт в Казани." },
  { id: "oleg-kid", section: "people", title: "Маша", body: "У Олега дочка Маша, ей 7 лет, занимается танцами." },
  { id: "lena-who", section: "people", title: "Лена", body: "Лена — моя жена, работает детским врачом в поликлинике." },
  { id: "dima", section: "people", title: "Дима", body: "Дима — школьный друг, вместе катаемся на велосипедах по выходным." },
  { id: "sergey", section: "people", title: "Сергей Иванович", body: "Сергей Иванович — мой начальник, не любит длинные письма." },
  { id: "anya-bday", section: "dates", title: "День рождения Ани", body: "День рождения Ани — 12 марта." },
  { id: "wedding", section: "dates", title: "Годовщина свадьбы", body: "Годовщина свадьбы с Леной — 3 июля." },
  { id: "car-service", section: "dates", title: "Техосмотр", body: "Техобслуживание Шкоды — каждый май, в дилерском центре на Таганрогской." },
  { id: "kitchen", section: "projects", title: "Ремонт кухни", body: "Ремонт кухни: заказали гарнитур, монтаж должен закончиться до декабря." },
  { id: "kassa", section: "projects", title: "Проект «Касса»", body: "Запуск новой версии «Кассы» — в ноябре, отвечаю за сроки." },
  { id: "spanish", section: "projects", title: "Испанский", body: "Учу испанский язык, занятия по вторникам с репетитором." },
  { id: "no-mushrooms", section: "preferences", title: "Грибы", body: "Не ем грибы — аллергии нет, просто не нравятся." },
  { id: "tea", section: "preferences", title: "Чай", body: "Пью зелёный чай без сахара, кофе почти не пью." },
  { id: "answers", section: "preferences", title: "Как отвечать", body: "Отвечай коротко, списком, без воды." },
  { id: "film", section: "preferences", title: "Фильм", body: "Любимый фильм — «Интерстеллар», пересматриваю раз в год." },
  { id: "borsch", section: "notes", title: "Борщ бабушки", body: "Бабушкин борщ: свёкла, фасоль, чернослив, томить два часа." },
  { id: "wifi-router", section: "notes", title: "Роутер", body: "Роутер дома — Keenetic, стоит в коридоре." },
  { id: "osago", section: "documents", title: "ОСАГО", body: "Полис ОСАГО действует до 14 мая, страховая «Ингосстрах»." },
  { id: "passport", section: "documents", title: "Паспорт", body: "Паспорт нужно заменить в 2027 году, в 45 лет." },
];

export const EVAL_QUESTIONS: EvalQuestion[] = [
  // Другие формы тех же слов
  { q: "Что любит Аня?", category: "forms", expect: ["anya-likes"] },
  { q: "Когда день рождения у Ани?", category: "forms", expect: ["anya-bday"] },
  { q: "Где живёт Олег?", category: "forms", expect: ["oleg-who"] },
  { q: "Какую Шкоду я вожу?", category: "forms", expect: ["me-car"] },
  { q: "Как дела с ремонтом кухни?", category: "forms", expect: ["kitchen"] },
  { q: "Когда запуск Кассы?", category: "forms", expect: ["kassa"] },
  { q: "Какие грибы я ем?", category: "forms", expect: ["no-mushrooms"] },
  { q: "Когда у меня занятия испанским?", category: "forms", expect: ["spanish"] },
  { q: "Как готовить бабушкин борщ?", category: "forms", expect: ["borsch"] },
  { q: "Когда годовщина свадьбы?", category: "forms", expect: ["wedding"] },
  { q: "Где стоит роутер?", category: "forms", expect: ["wifi-router"] },
  { q: "Кем работает Лена?", category: "forms", expect: ["lena-who"] },
  { q: "С кем я катаюсь на велосипеде?", category: "forms", expect: ["dima"] },
  { q: "Сколько лет Маше?", category: "forms", expect: ["oleg-kid"] },
  // Синонимы и родственные слова
  { q: "Какой у меня автомобиль?", category: "synonyms", expect: ["me-car"] },
  { q: "Какое кино мне нравится?", category: "synonyms", expect: ["film"] },
  { q: "Какой напиток я предпочитаю?", category: "synonyms", expect: ["tea"] },
  { q: "Где я работаю?", category: "synonyms", expect: ["me-job"] },
  { q: "В каком городе я живу?", category: "synonyms", expect: ["me-city"] },
  { q: "Когда ТО машины?", category: "synonyms", expect: ["car-service"] },
  { q: "Как зовут моего шефа?", category: "synonyms", expect: ["sergey"] },
  { q: "Какой иностранный язык я изучаю?", category: "synonyms", expect: ["spanish"] },
  // Через человека: в нужной записи нет слова из вопроса
  { q: "Что любит моя сестра?", category: "person", expect: ["anya-likes"] },
  { q: "Когда день рождения сестры?", category: "person", expect: ["anya-bday"] },
  { q: "Как зовут мою племянницу?", category: "person", expect: ["oleg-kid"] },
  { q: "Когда наша годовщина с женой?", category: "person", expect: ["wedding"] },
  { q: "Чем занимается дочь брата?", category: "person", expect: ["oleg-kid"] },
  { q: "Где живёт моя сестра?", category: "person", expect: ["anya-who"] },
  // По смыслу, без общих слов
  { q: "Чем угостить Аню, когда она приедет?", category: "meaning", expect: ["anya-likes"] },
  { q: "Что не стоит готовить мне на ужин?", category: "meaning", expect: ["no-mushrooms"] },
  { q: "Как мне лучше писать ответы?", category: "meaning", expect: ["answers"] },
  { q: "Что подарить жене на годовщину — и когда она?", category: "meaning", expect: ["wedding"] },
  { q: "Как написать письмо руководителю?", category: "meaning", expect: ["sergey"] },
  { q: "Когда будет готова новая кухня?", category: "meaning", expect: ["kitchen"] },
  // Ответа в памяти нет
  { q: "Сколько лет Роберту Де Ниро?", category: "absent", expect: [] },
  { q: "Какая погода в Сочи?", category: "absent", expect: [] },
  { q: "Как работает фотосинтез?", category: "absent", expect: [] },
  // Личный раздел «Документы»: его записи модели не уходят
  { q: "До какого числа действует ОСАГО?", category: "private", expect: [] },
  { q: "Когда менять паспорт?", category: "private", expect: [] },
];

/** Цели из плана; «после п. N» — когда цель должна быть достигнута. */
export const EVAL_TARGETS: Record<EvalCategory, { target: number; when: string }> = {
  forms: { target: 0.95, when: "сейчас" },
  synonyms: { target: 0.8, when: "после п. 12" },
  person: { target: 0.8, when: "после п. 12" },
  meaning: { target: 0.7, when: "после п. 13" },
  absent: { target: 1, when: "сейчас" },
  private: { target: 1, when: "сейчас" },
};
