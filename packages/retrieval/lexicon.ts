/**
 * Cross-lingual query expansion.
 *
 * The official service content is published in English, while citizens may ask
 * in Assamese or Hindi. BM25 cannot match across scripts, so frequent service
 * vocabulary is mapped to its English equivalent before retrieval. This is a
 * *retrieval aid only*: it is not government content, is never shown to users
 * as fact, and is not a substitute for multilingual semantic embeddings
 * (phase 9). Entries should be reviewed by a native speaker (see SECURITY/RAG docs).
 */
import { tokenize } from "../shared/tokenizer";

/** Indic-script token -> English search terms. Keys are tokenizer output (NFKC lower-case). */
const LEXICON: Record<string, string[]> = {
  // Assamese
  "আবেদন": ["application", "apply"],
  "প্ৰমাণপত্ৰ": ["certificate"],
  "প্রমাণপত্র": ["certificate"],
  "আয়": ["income"],
  "আয়ৰ": ["income"],
  "জন্ম": ["birth"],
  "মৃত্যু": ["death"],
  "বিবাহ": ["marriage"],
  "বাসিন্দা": ["residence", "resident"],
  "জাতি": ["caste"],
  "মাটি": ["land"],
  "ভূমি": ["land"],
  "জমি": ["land"],
  "পট্টা": ["patta"],
  "নামজাৰী": ["mutation"],
  "বিদ্যুৎ": ["electricity", "power"],
  "পানী": ["water"],
  "বৃত্তি": ["scholarship"],
  "পেঞ্চন": ["pension"],
  "অভিযোগ": ["grievance", "complaint"],
  "আপীল": ["appeal"],
  "নথিপত্ৰ": ["documents", "document"],
  "মাচুল": ["fee", "charges"],
  "যোগ্যতা": ["eligibility"],
  "গাড়ী": ["vehicle"],
  "বাহন": ["vehicle"],
  "অনুজ্ঞাপত্ৰ": ["licence", "license"],
  "ব্যৱসায়": ["trade", "business"],
  // Hindi
  "आवेदन": ["application", "apply"],
  "प्रमाण": ["certificate"],
  "प्रमाणपत्र": ["certificate"],
  "आय": ["income"],
  "जन्म": ["birth"],
  "मृत्यु": ["death"],
  "विवाह": ["marriage"],
  "निवास": ["residence", "residential"],
  "जाति": ["caste"],
  "भूमि": ["land"],
  "जमीन": ["land"],
  "पट्टा": ["patta"],
  "बिजली": ["electricity", "power"],
  "पानी": ["water"],
  "छात्रवृत्ति": ["scholarship"],
  "पेंशन": ["pension"],
  "शिकायत": ["grievance", "complaint"],
  "अपील": ["appeal"],
  "दस्तावेज": ["documents", "document"],
  "दस्तावेज़": ["documents", "document"],
  "शुल्क": ["fee", "charges"],
  "फीस": ["fee", "charges"],
  "पात्रता": ["eligibility"],
  "वाहन": ["vehicle"],
  "लाइसेंस": ["licence", "license"],
  "व्यापार": ["trade", "business"],
};

/**
 * Returns the question's own tokens plus English expansions for known Indic terms.
 * English-only questions pass through unchanged.
 */
export function expandQueryTerms(question: string): string[] {
  const tokens = tokenize(question);
  const expanded = [...tokens];
  for (const token of tokens) {
    const english = LEXICON[token];
    if (english) for (const e of english) expanded.push(...tokenize(e));
  }
  return expanded;
}
