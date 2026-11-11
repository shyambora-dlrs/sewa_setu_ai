/** Cross-cutting constants shared by the Worker, packages and frontend. */

export const SUPPORTED_LANGUAGES = ["en", "as", "hi"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** Object keys inside the R2 bucket. Centralised so no module builds paths ad hoc. */
export const R2_KEYS = {
  current: "current.json",
  releasePrefix: (releaseId: string) => `releases/${releaseId}/`,
  reviewState: "admin/review-state.json",
  override: (serviceId: string) => `admin/overrides/${serviceId}.json`,
  uploadsIndex: "admin/uploads/index.json",
  upload: (sha256: string) => `admin/uploads/${sha256}.pdf`,
  feedbackPrefix: "feedback/",
} as const;

/** Hard limits that protect the Worker CPU budget and the Groq bill. */
export const LIMITS = {
  chatQuestionChars: 1000,
  chatHistoryMessages: 6,
  chatHistoryMessageChars: 1200,
  maxPageSize: 50,
  defaultPageSize: 20,
  maxSearchResults: 20,
  maxContextChars: 9000,
  maxRetrievedChunks: 8,
  candidateChunks: 24,
  adminUploadBytes: 20 * 1024 * 1024,
  requestBodyBytes: 64 * 1024,
} as const;

export const INDEPENDENT_DISCLAIMER: Record<Language, string> = {
  en: "Please verify current requirements on the official Sewa Setu portal before applying. This is an independent guidance assistant, not an official Government of Assam service.",
  hi: "आवेदन करने से पहले कृपया आधिकारिक सेवा सेतु पोर्टल पर वर्तमान आवश्यकताओं की पुष्टि करें। यह एक स्वतंत्र मार्गदर्शन सहायक है, असम सरकार की आधिकारिक सेवा नहीं।",
  as: "আবেদন কৰাৰ আগতে অনুগ্ৰহ কৰি আনুষ্ঠানিক সেৱা সেতু পোৰ্টেলত বৰ্তমানৰ প্ৰয়োজনীয়তা নিশ্চিত কৰক। এইটো এটা স্বতন্ত্ৰ পথ-প্ৰদৰ্শন সহায়ক, অসম চৰকাৰৰ আনুষ্ঠানিক সেৱা নহয়।",
};
