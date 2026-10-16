/** How a question is turned into full-text searches: the whole phrase, each
 * keyword, and each keyword's stem so other word forms match. */

export const STOP_WORDS = new Set(["что", "как", "где", "когда", "кто", "чем", "мне", "меня", "мой", "моя", "моё", "мои", "моих", "моей", "моего",
  "для", "это", "эта", "этот", "эти", "найди", "найти", "пожалуйста", "расскажи", "напомни", "помоги", "подскажи", "скажи", "знаешь", "помнишь",
  "интернет", "интернете", "есть", "был", "была", "было", "про", "при", "или", "его", "её", "них", "там", "тут", "так", "уже", "ещё", "еще", "мы", "вы", "ты",
  // Question and helper words: they occur everywhere and found unrelated notes
  // («Сколько лет Де Ниро?» → «Маше 7 лет»), so the assistant skipped the internet.
  "какой", "какая", "какое", "какие", "каких", "каким", "какую", "каком", "сколько", "который", "которая", "которое", "которые",
  "зовут", "лет", "год", "года", "году", "лучше", "стоит", "нужно", "надо", "можно", "будет", "буду", "будут", "чтобы", "если", "тоже", "очень",
  "сейчас", "сегодня", "всегда", "никогда", "всё", "все", "мой", "наш", "наша", "наше", "наши", "свой", "своя", "себя", "она", "оно", "они", "него", "неё",
  "почему", "зачем", "откуда", "куда", "чей", "чья", "чьё",
  // «Как работает X» asks how something works, not about anyone's job.
  "работает"]);
// Longest first, so «ами» is removed before «и».
const RU_ENDINGS = ["иями", "ями", "ами", "ого", "его", "ому", "ему", "ыми", "ими", "ость", "ах", "ях", "ам", "ям", "ов", "ев", "ей", "ой", "ий", "ый",
  "ая", "яя", "ое", "ее", "ые", "ие", "ую", "юю", "ом", "ем", "ть", "ся", "а", "я", "о", "е", "ы", "и", "у", "ю", "ь", "й"];

/** The search index folds «ё» into «е»: SQLite's tokenizer keeps them apart. */
export const foldText = (text: string): string => text.replace(/ё/g, "е").replace(/Ё/g, "Е");

/** A word without its Russian ending, for prefix search («машину» → «машин»). */
export function wordStem(word: string): string {
  const w = word.toLowerCase();
  if (!/[а-яё]/.test(w)) return w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w;
  for (const ending of RU_ENDINGS) {
    if (w.endsWith(ending) && w.length - ending.length >= 3) return w.slice(0, -ending.length);
  }
  return w;
}

/** `column: "terms"` searches only index words and names: a short stem
 * («шеф» from «шефа») is too broad for the text but fine for chosen words. */
export type MemorySearchStep = { term: string; prefix: boolean; weight: number; column?: "terms" };

/** Searches from the most specific to the broadest. A question about the user
 * («что ты знаешь обо мне») returns one empty search: the latest records. */
export function searchSteps(query: string): MemorySearchStep[] {
  const q = query.trim().slice(0, 120);
  if (q.length < 2) return [];
  if (/(?:помнишь|знаешь|расскажи).*(?:обо? мне|про меня)|кто я\b/iu.test(q)) return [{ term: "", prefix: false, weight: 1 }];
  const tokens = q.split(/[^\p{L}\p{N}-]+/u).filter(Boolean);
  // A capitalised word after the first is a name («Маше», «Аню»): its stem may be short.
  const names = new Set(tokens.slice(1).filter(t => /^\p{Lu}\p{Ll}/u.test(t)).map(t => t.toLowerCase()));
  const words = [...new Set(tokens.map(t => t.toLowerCase()).filter(s => (s.length >= 3 || names.has(s)) && !STOP_WORDS.has(s)))].slice(0, 6);
  const stemOf = (w: string) => names.has(w) ? w.replace(/(ой|ей|ею|ою|[аяеиыуюо])$/u, "") : wordStem(w);
  const stems = words.map(w => ({ term: stemOf(w), word: w })).filter(s => s.term !== s.word);
  return [
    { term: q, prefix: false, weight: 4 },
    ...words.map(w => ({ term: w, prefix: false, weight: 2 })),
    // A stem shorter than four letters («как», «лет») matches too much; names may be shorter.
    ...stems.filter(s => s.term.length >= (names.has(s.word) ? 2 : 4)).map(s => ({ term: s.term, prefix: true, weight: 1 })),
    ...stems.filter(s => s.term.length === 3 && !names.has(s.word)).map(s => ({ term: s.term, prefix: true, weight: 1, column: "terms" as const })),
  ];
}

/** One quoted FTS5 phrase: user input never becomes query operators. */
export const ftsPhrase = (term: string, prefix = false, column?: "terms"): string =>
  (column ? "{terms aliases} : " : "") + '"' + foldText(term).replace(/"/g, '""') + '"' + (prefix ? "*" : "");
