import fs from "fs";
import path from "path";
import { cleanupImage } from "../src/imageCleanup";

(async () => {
  const inPath = process.argv[2];
  if (!inPath) {
    console.error("usage: ts-node scripts/testCleanup.ts <image>");
    process.exit(1);
  }
  const buf = fs.readFileSync(inPath);
  const t0 = Date.now();
  const result = await cleanupImage(buf);
  console.log("took ms:", Date.now() - t0);
  console.log("cleaned:", result.cleaned);
  console.log("reason:", result.reason);
  const outPath = path.join(
    path.dirname(inPath),
    path.basename(inPath, path.extname(inPath)) + "_autoclean.jpg"
  );
  fs.writeFileSync(outPath, result.buffer);
  console.log("wrote:", outPath);
})();
