/** Regenerates tests/fixtures/tokenizer-cases.json from the TypeScript reference tokenizer. */
import { writeFileSync } from "node:fs";
import { fnv1a32, tokenize } from "../packages/shared/tokenizer";

const texts = [
  "What documents are required for an Income Certificate?",
  "Fees/Charges: User/Statutory charges -Rs. 30",
  "Application for Trade Licences and certificates",
  "Services of the Revenue & Disaster Management department",
  "আয়ৰ প্ৰমাণপত্ৰৰ বাবে আবেদন",
  "आय प्रमाण पत्र के लिए आवेदन कैसे करें?",
  "RC ST/SC/OBC 2026 1 a I",
  "class ss bus analysis ties entries glass",
  "ＦＵＬＬＷＩＤＴＨ Ｔｅｘｔ ٣٤٥",
];
const cases = texts.map((text) => ({ text, tokens: tokenize(text) }));
const terms = ["certificate", "income", "আবেদন", "प्रमाण", "fee", "trade"];
writeFileSync("tests/fixtures/tokenizer-cases.json", JSON.stringify({ cases, hashes: terms.map((t) => ({ term: t, fnv1a32: fnv1a32(t) })) }, null, 2) + "\n");
