/**
 * Input-safety guards for citizen questions.
 *
 * Citizens sometimes paste Aadhaar numbers, OTPs or bank details. We never need
 * them, must not forward them to a third-party LLM, and must not log them.
 */

export interface GuardResult {
  /** Question text with sensitive tokens replaced by "[removed]". */
  sanitized: string;
  /** True when something sensitive was found and removed. */
  hadSensitiveData: boolean;
  /** True when the user is asking about the status of their own application. */
  asksApplicationStatus: boolean;
}

// 12 digits, optionally grouped 4-4-4 (Aadhaar); or any digit run of 9+ (bank/account/phone-like).
const AADHAAR = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g;
const LONG_DIGITS = /\b\d{9,}\b/g;
// "otp 123456", "otp is 123456", "pin: 1234", "password: xyz"
const SECRET_PHRASE = /\b(otp|pin|password|passwd|cvv)\b\s*(is|:|=)?\s*\S+/gi;

const STATUS_EN = /\b(status|track|tracking)\b[^.?!]{0,40}\b(my|application|applied|submitted)\b|\b(my|application)\b[^.?!]{0,40}\b(status|track)\b/i;
const STATUS_INDIC = /(स्थिति|ट्रैक|স্থিতি|ট্ৰেক)/;

export function guardQuestion(question: string): GuardResult {
  let sanitized = question;
  let hadSensitiveData = false;
  for (const re of [SECRET_PHRASE, AADHAAR, LONG_DIGITS]) {
    sanitized = sanitized.replace(re, () => {
      hadSensitiveData = true;
      return "[removed]";
    });
  }
  const asksApplicationStatus = STATUS_EN.test(sanitized) || (STATUS_INDIC.test(sanitized) && /(मेरा|मेरे|আমাৰ|মোৰ|आवेदन|আবেদন)/.test(sanitized));
  return { sanitized, hadSensitiveData, asksApplicationStatus };
}
