/**
 * e-Way Bill server (TypeScript + Express). Keyless: uses a local Ollama vision model.
 * Endpoints mirror the Flask app: /process, /parse_text, /download, /health, /.
 */
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";

import { extractFields, extractFromText } from "./llmExtract";
import { buildPdf } from "./pdfBuilder";
import { toMastersIndia, safeName } from "./mastersIndia";
import { UPLOAD_DIR, OUTPUT_DIR, PORT } from "./config";

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: "25mb" }));
const upload = multer({ dest: UPLOAD_DIR });

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

// Lightweight keep-alive — no model call, so it never costs anything.
app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/process", upload.any(), async (req, res) => {
  try {
    const files = (req.files as Express.Multer.File[]) || [];
    let b64: string;
    let mime = "image/jpeg";
    if (files.length) {
      b64 = fs.readFileSync(files[0].path).toString("base64");
      mime = files[0].mimetype || mime;
    } else if (req.body && req.body.image_base64) {
      let raw: string = req.body.image_base64;
      if (raw.includes(",") && raw.trim().toLowerCase().startsWith("data:")) raw = raw.split(",")[1];
      b64 = raw;
    } else {
      return res.status(400).json({ status: false, message: "No file uploaded." });
    }

    const data = await extractFields(b64, mime);
    const ewbNo = String(data.eway_bill_no || Date.now());
    const base = safeName(ewbNo);

    const jsonName = `${base}.json`;
    fs.writeFileSync(path.join(OUTPUT_DIR, jsonName), JSON.stringify(data, null, 2), "utf-8");
    const pdfName = `${base}_eway.pdf`;
    await buildPdf(data, path.join(OUTPUT_DIR, pdfName));

    res.json({
      status: true,
      message: "Extracted",
      ewb_no: ewbNo,
      json: data,
      data: toMastersIndia(data),
      json_url: `/download/${jsonName}`,
      pdf_url: `/download/${pdfName}`,
    });
  } catch (e: any) {
    res.status(500).json({ status: false, message: `${e.name || "Error"}: ${e.message || e}` });
  }
});

app.post("/parse_text", async (req, res) => {
  try {
    const rawText = (req.body && req.body.text) || "";
    if (!String(rawText).trim()) return res.status(400).json({ status: false, message: "No text provided." });

    const data = await extractFromText(rawText);
    const ewbNo = String(data.eway_bill_no || Date.now());
    const base = safeName(ewbNo);

    const jsonName = `${base}.json`;
    fs.writeFileSync(path.join(OUTPUT_DIR, jsonName), JSON.stringify(data, null, 2), "utf-8");
    const pdfName = `${base}_eway.pdf`;
    await buildPdf(data, path.join(OUTPUT_DIR, pdfName));

    res.json({
      status: true,
      message: "Parsed",
      ewb_no: ewbNo,
      json: data,
      data: toMastersIndia(data),
      json_url: `/download/${jsonName}`,
      pdf_url: `/download/${pdfName}`,
    });
  } catch (e: any) {
    res.status(500).json({ status: false, message: `${e.name || "Error"}: ${e.message || e}` });
  }
});

app.get("/download/:fname", (req, res) => {
  res.sendFile(path.resolve(OUTPUT_DIR, req.params.fname));
});

app.listen(PORT, () => console.log(`e-Way Bill (Ollama, keyless) -> http://localhost:${PORT}`));
