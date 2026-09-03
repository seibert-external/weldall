/** Languages with both stemming and stop-word support in the Orama packages. */
export const SUPPORTED_SEARCH_LANGUAGES = [
  "arabic",
  "armenian",
  "bulgarian",
  "danish",
  "dutch",
  "english",
  "finnish",
  "french",
  "german",
  "greek",
  "hungarian",
  "indian",
  "indonesian",
  "irish",
  "italian",
  "lithuanian",
  "nepali",
  "norwegian",
  "portuguese",
  "romanian",
  "russian",
  "sanskrit",
  "serbian",
  "spanish",
  "swedish",
  "tamil",
  "turkish",
  "ukrainian",
] as const;

/** A language supported by the Starlight search tokenizer. */
export type SearchLanguage = (typeof SUPPORTED_SEARCH_LANGUAGES)[number];

type StemmerModule = { stemmer: (word: string) => string };
type StopwordsModule = { stopwords: string[] };
type AnalysisLoader = () => Promise<[StemmerModule, StopwordsModule]>;

const analysisLoaders = {
  arabic: () => Promise.all([import("@orama/stemmers/arabic"), import("@orama/stopwords/arabic")]),
  armenian: () =>
    Promise.all([import("@orama/stemmers/armenian"), import("@orama/stopwords/armenian")]),
  bulgarian: () =>
    Promise.all([import("@orama/stemmers/bulgarian"), import("@orama/stopwords/bulgarian")]),
  danish: () => Promise.all([import("@orama/stemmers/danish"), import("@orama/stopwords/danish")]),
  dutch: () => Promise.all([import("@orama/stemmers/dutch"), import("@orama/stopwords/dutch")]),
  english: () =>
    Promise.all([import("@orama/stemmers/english"), import("@orama/stopwords/english")]),
  finnish: () =>
    Promise.all([import("@orama/stemmers/finnish"), import("@orama/stopwords/finnish")]),
  french: () => Promise.all([import("@orama/stemmers/french"), import("@orama/stopwords/french")]),
  german: () => Promise.all([import("@orama/stemmers/german"), import("@orama/stopwords/german")]),
  greek: () => Promise.all([import("@orama/stemmers/greek"), import("@orama/stopwords/greek")]),
  hungarian: () =>
    Promise.all([import("@orama/stemmers/hungarian"), import("@orama/stopwords/hungarian")]),
  indian: () => Promise.all([import("@orama/stemmers/indian"), import("@orama/stopwords/indian")]),
  indonesian: () =>
    Promise.all([import("@orama/stemmers/indonesian"), import("@orama/stopwords/indonesian")]),
  irish: () => Promise.all([import("@orama/stemmers/irish"), import("@orama/stopwords/irish")]),
  italian: () =>
    Promise.all([import("@orama/stemmers/italian"), import("@orama/stopwords/italian")]),
  lithuanian: () =>
    Promise.all([import("@orama/stemmers/lithuanian"), import("@orama/stopwords/lithuanian")]),
  nepali: () => Promise.all([import("@orama/stemmers/nepali"), import("@orama/stopwords/nepali")]),
  norwegian: () =>
    Promise.all([import("@orama/stemmers/norwegian"), import("@orama/stopwords/norwegian")]),
  portuguese: () =>
    Promise.all([import("@orama/stemmers/portuguese"), import("@orama/stopwords/portuguese")]),
  romanian: () =>
    Promise.all([import("@orama/stemmers/romanian"), import("@orama/stopwords/romanian")]),
  russian: () =>
    Promise.all([import("@orama/stemmers/russian"), import("@orama/stopwords/russian")]),
  sanskrit: () =>
    Promise.all([import("@orama/stemmers/sanskrit"), import("@orama/stopwords/sanskrit")]),
  serbian: () =>
    Promise.all([import("@orama/stemmers/serbian"), import("@orama/stopwords/serbian")]),
  spanish: () =>
    Promise.all([import("@orama/stemmers/spanish"), import("@orama/stopwords/spanish")]),
  swedish: () =>
    Promise.all([import("@orama/stemmers/swedish"), import("@orama/stopwords/swedish")]),
  tamil: () => Promise.all([import("@orama/stemmers/tamil"), import("@orama/stopwords/tamil")]),
  turkish: () =>
    Promise.all([import("@orama/stemmers/turkish"), import("@orama/stopwords/turkish")]),
  ukrainian: () =>
    Promise.all([import("@orama/stemmers/ukrainian"), import("@orama/stopwords/ukrainian")]),
} satisfies Record<SearchLanguage, AnalysisLoader>;

/** Loads the language-specific tokenizer components from the optional peers. */
export async function loadLanguageAnalysis(language: string): Promise<{
  language: SearchLanguage;
  stemmer: (word: string) => string;
  stopWords: string[];
}> {
  const loader = analysisLoaders[language as SearchLanguage] as AnalysisLoader | undefined;
  if (!loader) {
    throw new Error(
      `Unsupported search language "${language}". Supported languages: ${SUPPORTED_SEARCH_LANGUAGES.join(", ")}`,
    );
  }
  const [{ stemmer }, { stopwords }] = await loader();
  return { language: language as SearchLanguage, stemmer, stopWords: stopwords };
}
