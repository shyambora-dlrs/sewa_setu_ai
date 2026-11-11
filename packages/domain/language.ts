/**
 * Language detection and the small multilingual message catalogue used by
 * backend responses (the React app has its own UI dictionary).
 */
import type { Language } from "../shared/constants";

/**
 * Detects the likely language of a question from its script.
 * Devanagari -> Hindi; Bengali-Assamese script -> Assamese (the portal's second
 * language); anything else -> English. Romanised Hindi/Assamese is not detected,
 * callers may pass an explicit language which always wins.
 */
export function detectLanguage(text: string): Language {
  let devanagari = 0;
  let bengali = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x0900 && cp <= 0x097f) devanagari++;
    else if (cp >= 0x0980 && cp <= 0x09ff) bengali++;
  }
  if (devanagari === 0 && bengali === 0) return "en";
  return devanagari >= bengali ? "hi" : "as";
}

/** Fixed messages for situations where the model is deliberately NOT called. */
export const MESSAGES: Record<string, Record<Language, string>> = {
  noEvidence: {
    en: "I could not find official information about this in the Sewa Setu knowledge base, so I cannot confirm it. Please check the official Sewa Setu portal or contact the concerned department.",
    hi: "मुझे सेवा सेतु ज्ञान-आधार में इसके बारे में आधिकारिक जानकारी नहीं मिली, इसलिए मैं इसकी पुष्टि नहीं कर सकता। कृपया आधिकारिक सेवा सेतु पोर्टल देखें या संबंधित विभाग से संपर्क करें।",
    as: "সেৱা সেতুৰ জ্ঞান-ভাণ্ডাৰত এই বিষয়ে আনুষ্ঠানিক তথ্য পোৱা নগ'ল, গতিকে মই নিশ্চিত কৰিব নোৱাৰোঁ। অনুগ্ৰহ কৰি আনুষ্ঠানিক সেৱা সেতু পোৰ্টেল চাওক বা সংশ্লিষ্ট বিভাগৰ সৈতে যোগাযোগ কৰক।",
  },
  sensitiveData: {
    en: "For your safety, please do not share Aadhaar numbers, OTPs, passwords or bank details here. I have ignored those details; ask your question without them.",
    hi: "आपकी सुरक्षा के लिए कृपया यहाँ आधार नंबर, ओटीपी, पासवर्ड या बैंक विवरण साझा न करें। मैंने उन विवरणों को अनदेखा कर दिया है; कृपया उनके बिना प्रश्न पूछें।",
    as: "আপোনাৰ সুৰক্ষাৰ বাবে অনুগ্ৰহ কৰি ইয়াত আধাৰ নম্বৰ, ওটিপি, পাছৱৰ্ড বা বেংক বিৱৰণ ভাগ-বতৰা নকৰিব। মই সেই তথ্যবোৰ আওকাণ কৰিছোঁ; সেইবোৰ নোহোৱাকৈ প্ৰশ্ন সোধক।",
  },
  statusRequest: {
    en: "I cannot see or track individual applications. To check an application's status, use the Track option on the official Sewa Setu portal with your application reference number.",
    hi: "मैं व्यक्तिगत आवेदनों को देख या ट्रैक नहीं कर सकता। आवेदन की स्थिति जानने के लिए आधिकारिक सेवा सेतु पोर्टल पर अपने आवेदन संदर्भ संख्या के साथ 'Track' विकल्प का उपयोग करें।",
    as: "মই ব্যক্তিগত আবেদন চাব বা ট্ৰেক কৰিব নোৱাৰোঁ। আবেদনৰ স্থিতি জানিবলৈ আনুষ্ঠানিক সেৱা সেতু পোৰ্টেলত আপোনাৰ আবেদন প্ৰসংগ নম্বৰ দি 'Track' বিকল্প ব্যৱহাৰ কৰক।",
  },
  unverifiedNotice: {
    en: "Note: some of this information was taken from the official Sewa Setu portal but has not yet been reviewed by an administrator. Please confirm it on the official portal.",
    hi: "ध्यान दें: इस जानकारी में से कुछ आधिकारिक सेवा सेतु पोर्टल से ली गई है, लेकिन अभी किसी व्यवस्थापक द्वारा इसकी समीक्षा नहीं की गई है। कृपया आधिकारिक पोर्टल पर इसकी पुष्टि करें।",
    as: "টোকা: এই তথ্যৰ কিছু অংশ আনুষ্ঠানিক সেৱা সেতু পোৰ্টেলৰ পৰা লোৱা হৈছে, কিন্তু এতিয়ালৈকে কোনো প্ৰশাসকে ইয়াক পৰ্যালোচনা কৰা নাই। অনুগ্ৰহ কৰি আনুষ্ঠানিক পোৰ্টেলত নিশ্চিত কৰক।",
  },
  noCitations: {
    en: "Note: this answer could not be matched to specific official passages. Please rely on the source links shown below.",
    hi: "ध्यान दें: इस उत्तर को विशिष्ट आधिकारिक अंशों से मिलाया नहीं जा सका। कृपया नीचे दिए गए स्रोत लिंक पर भरोसा करें।",
    as: "টোকা: এই উত্তৰটো নিৰ্দিষ্ট আনুষ্ঠানিক অংশৰ সৈতে মিলোৱা নগ'ল। অনুগ্ৰহ কৰি তলত দিয়া উৎস লিংকবোৰৰ ওপৰত নিৰ্ভৰ কৰক।",
  },
  degraded: {
    en: "The AI assistant is temporarily unavailable, so I cannot write a summary right now. The most relevant official passages are listed below.",
    hi: "एआई सहायक अस्थायी रूप से उपलब्ध नहीं है, इसलिए मैं अभी सारांश नहीं लिख सकता। सबसे प्रासंगिक आधिकारिक अंश नीचे सूचीबद्ध हैं।",
    as: "এআই সহায়ক সাময়িকভাৱে উপলব্ধ নহয়, গতিকে মই এতিয়া সাৰাংশ লিখিব নোৱাৰোঁ। আটাইতকৈ প্ৰাসংগিক আনুষ্ঠানিক অংশবোৰ তলত দিয়া হ'ল।",
  },
};
