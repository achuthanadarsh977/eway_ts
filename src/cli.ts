/**
 * Quick command-line test:  npm run extract <path-to-image>
 */
import fs from "fs";
import { extractFields } from "./llmExtract";

(async () => {
  const p = process.argv[2];
  if (!p) {
    console.error("usage: npm run extract <image>");
    process.exit(1);
  }
  const b64 = fs.readFileSync(p).toString("base64");
  const data = await extractFields(b64);
  console.log(JSON.stringify(data, null, 2));
})();
