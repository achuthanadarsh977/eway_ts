/**
 * e-Way Bill extraction. Two providers:
 *   - "groq"   : cloud vision, ~2 seconds, accurate (needs GROQ_API_KEY)
 *   - "ollama" : local vision, keyless, slow on CPU
 * Same JSON schema either way.
 */
import { Ollama } from "ollama";
import {
  PROVIDER, OLLAMA_HOST, OLLAMA_MODEL,
  GROQ_API_KEY, GROQ_MODEL, GROQ_URL,
  OPENAI_API_KEY, OPENAI_MODEL, OPENAI_URL,
  OPENROUTER_API_KEY, OPENROUTER_MODEL, OPENROUTER_URL,
  CEREBRAS_API_KEY, CEREBRAS_MODEL, CEREBRAS_URL,
} from "./config";
import { cleanupImage } from "./imageCleanup";

// Vision-capable — used by extractFields (image upload).
const CLOUD_PROVIDERS = ["groq", "openai", "openrouter"];
// Cerebras has no image_url support today, so it's added only for the
// text/OCR path (extractFromText), not the vision path above.
const TEXT_PROVIDERS = [...CLOUD_PROVIDERS, "cerebras"];

const ollama = new Ollama({ host: OLLAMA_HOST });

const SCHEMA_HINT = `{
  "document_type": "E-Way Bill",
  "eway_bill_no": "",
  "eway_bill_status": "",
  "summary": {
    "eway_bill_date": "",
    "generated_by": { "gstin": "", "name": "" },
    "valid_from": "",
    "distance_km": 0,
    "valid_until": "",
    "portal": "1"
  },
  "irn_details": {
    "irn": null,
    "irn_date": null,
    "ack_no": null
  },
  "part_a": {
    "supplier": { "gstin": "", "name": "" },
    "place_of_dispatch": "",
    "recipient": { "gstin": "", "name": "" },
    "place_of_delivery": "",
    "document_no": "",
    "document_date": "",
    "transaction_type": "",
    "value_of_goods": 0,
    "hsn_code": "",
    "hsn_description": "",
    "reason_for_transportation": "",
    "transporter": { "id": "", "name": "" }
  },
  "part_b": [
    {
      "mode": "Road",
      "vehicle_trans_doc_no_and_dt": "",
      "from": "",
      "entered_date": "",
      "entered_by": "",
      "cewb_no": null,
      "multi_vehicle_info": null,
      "portal": "1"
    }
  ],
  "barcode_value": ""
}`;

const RULES =
  "Rules:\n" +
  "- Output valid JSON only.\n" +
  "- Transcribe GSTINs, document numbers and numeric values EXACTLY, character by character. " +
  "If any single character is not clearly legible, output null for that whole field instead of " +
  "guessing a plausible-looking value — a wrong GSTIN or document number is worse than a missing one.\n" +
  "- Remove spaces inside GSTINs and the EWB number.\n" +
  "- Every GSTIN (generated_by, supplier, recipient, transporter.id) is exactly 15 characters in the " +
  "shape 99AAAAA9999A9Z9 (2 digits, 5 letters, 4 digits, 1 letter, 1 alphanumeric, literal 'Z', 1 " +
  "alphanumeric). Re-read the image if your transcription doesn't have exactly 15 characters.\n" +
  "- Double-check the recipient GSTIN specifically: it often differs from the supplier only by the " +
  "2-digit state code and last char, so do not just copy the supplier's GSTIN — read the recipient's " +
  "row independently.\n" +
  "- transporter.id and transporter.name are SEPARATE fields (often shown as 'ID & NAME' or 'ID - NAME' " +
  "on the form). Split them; never concatenate transporter id and name into one string.\n" +
  "- document_no is the invoice/challan number printed next to the 'Document No' label — it is " +
  "alphanumeric and is NEVER a date. document_date is the date next to 'Document Date'. If you cannot " +
  "find a document number distinct from the document date, set document_no to null rather than " +
  "repeating the date or a nearby number from another field.\n" +
  "- transaction_type must be exactly what is printed next to the 'Transaction Type' label — it is one " +
  "of: Regular, Bill To - Ship To, Bill From - Dispatch From, Combination, or a stock-transfer variant. " +
  "It is a DIFFERENT field from 'Reason for Transportation' (which is often 'Outward Supply'/'Outward - " +
  "Supply') — do not copy the reason-for-transportation value into transaction_type.\n" +
  "- value_of_goods and distance_km must be numbers (no commas, no currency symbol).\n" +
  "- Keep company names UPPERCASE.\n" +
  "- Use null for empty '-' fields, and for irn/irn_date/ack_no when there is no 'IRN Details' section " +
  "on the document at all.\n" +
  "- barcode_value = the e-Way Bill number.\n" +
  "- Dates exactly as shown (DD/MM/YYYY, include time if present).";

const IMAGE_PROMPT =
  "You are an expert Indian GST e-Way Bill data extractor. Read the e-Way Bill in the " +
  "image and return ONLY a JSON object with this exact structure:\n" +
  SCHEMA_HINT + "\n\n" + RULES;

const TEXT_PROMPT =
  "You are an expert Indian GST e-Way Bill data extractor. Below is the raw OCR text " +
  "from an e-Way Bill. Read it and return ONLY a JSON object with this exact structure:\n" +
  SCHEMA_HINT + "\n\n" + RULES + "\n" +
  "- The OCR text may be jumbled or noisy; use the standard e-Way Bill layout to map " +
  "each value to the correct field.\n\nRAW OCR TEXT:\n";

function nospace(v: any): any {
  return v ? String(v).replace(/\s+/g, "") : v;
}

function normalize(data: any): any {
  data = data || {};
  data.eway_bill_no = nospace(data.eway_bill_no || "");
  data.barcode_value = nospace(data.barcode_value || "") || data.eway_bill_no;
  const gb = (data.summary && data.summary.generated_by) || {};
  if (gb.gstin) gb.gstin = nospace(gb.gstin);
  const a = data.part_a || {};
  for (const key of ["supplier", "recipient"]) {
    const d = a[key] || {};
    if (d.gstin) d.gstin = nospace(d.gstin);
  }
  const tr = a.transporter || {};
  if (tr.id) tr.id = nospace(tr.id);
  for (const r of data.part_b || []) {
    if (r && r.entered_by) r.entered_by = nospace(r.entered_by);
  }
  const irn = data.irn_details || {};
  if (irn.irn) irn.irn = nospace(irn.irn).toLowerCase();
  if (irn.ack_no) irn.ack_no = nospace(irn.ack_no);
  return data;
}

function parseJson(raw: string): any {
  raw = raw.trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "").trim();
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end !== -1) raw = raw.slice(start, end + 1);
  return JSON.parse(raw);
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const EWB_RE = /^[0-9]{12}$/;
const DATE_LIKE_RE = /^[0-9]{2}\/[0-9]{2}\/[0-9]{4}/;
const VEHICLE_RE = /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/;
const KNOWN_TRANSACTION_TYPES = [
  "regular",
  "bill to - ship to",
  "bill from - dispatch from",
  "combination of 2 and 3",
  "combination",
];

// Shape-only sanity checks on the model's output. These catch the class of
// failure where a vision model hallucinates a plausible-looking value on a
// noisy/skewed photo (wrong-length GSTIN, a date landing in document_no,
// a malformed vehicle plate) instead of admitting it couldn't read the
// field. Never corrects or drops data — just flags it so a caller (Zoho,
// a human reviewer) knows a field needs re-checking against the source image.
function validate(data: any): string[] {
  const warnings: string[] = [];
  const s = data.summary || {};
  const a = data.part_a || {};
  const gen = s.generated_by || {};
  const sup = a.supplier || {};
  const rec = a.recipient || {};
  const tr = a.transporter || {};

  if (data.eway_bill_no && !EWB_RE.test(data.eway_bill_no)) {
    warnings.push(`eway_bill_no "${data.eway_bill_no}" is not 12 digits.`);
  }
  if (gen.gstin && !GSTIN_RE.test(gen.gstin)) {
    warnings.push(`summary.generated_by.gstin "${gen.gstin}" does not match the 15-char GSTIN shape.`);
  }
  if (sup.gstin && !GSTIN_RE.test(sup.gstin)) {
    warnings.push(`part_a.supplier.gstin "${sup.gstin}" does not match the 15-char GSTIN shape.`);
  }
  if (rec.gstin && !GSTIN_RE.test(rec.gstin)) {
    warnings.push(`part_a.recipient.gstin "${rec.gstin}" does not match the 15-char GSTIN shape.`);
  }
  if (tr.id && !GSTIN_RE.test(tr.id)) {
    warnings.push(`part_a.transporter.id "${tr.id}" does not match the 15-char GSTIN shape.`);
  }
  if (a.document_no && DATE_LIKE_RE.test(a.document_no)) {
    warnings.push(`part_a.document_no "${a.document_no}" looks like a date, not a document number.`);
  }
  if (a.transaction_type && !KNOWN_TRANSACTION_TYPES.includes(String(a.transaction_type).trim().toLowerCase())) {
    warnings.push(
      `part_a.transaction_type "${a.transaction_type}" is not one of the standard EWB transaction types ` +
        `— check it wasn't copied from reason_for_transportation.`
    );
  }
  (data.part_b || []).forEach((r: any, i: number) => {
    const vNo = String(r?.vehicle_trans_doc_no_and_dt || "")
      .split(/[ &]/)[0]
      .replace(/-/g, "")
      .toUpperCase();
    if (vNo && !VEHICLE_RE.test(vNo)) {
      warnings.push(`part_b[${i}].vehicle_trans_doc_no_and_dt "${vNo}" does not match the standard vehicle-plate shape.`);
    }
  });
  return warnings;
}

function finish(data: any, cleanup?: { cleaned: boolean; reason: string }): any {
  if (!data.barcode_value) data.barcode_value = data.eway_bill_no || "";
  const normalized = normalize(data);
  const warnings = validate(normalized);
  if (warnings.length) normalized._warnings = warnings;
  if (cleanup) {
    normalized._image_cleaned = cleanup.cleaned;
    normalized._image_cleanup_reason = cleanup.reason;
  }
  return normalized;
}

// ---------- OpenAI-compatible cloud chat (Groq & OpenAI share this format) ----------
async function cloudChat(content: any): Promise<string> {
  let url = GROQ_URL, key = GROQ_API_KEY, model = GROQ_MODEL, name = "GROQ";
  if (PROVIDER === "openai") {
    url = OPENAI_URL; key = OPENAI_API_KEY; model = OPENAI_MODEL; name = "OPENAI";
  } else if (PROVIDER === "openrouter") {
    url = OPENROUTER_URL; key = OPENROUTER_API_KEY; model = OPENROUTER_MODEL; name = "OPENROUTER";
  } else if (PROVIDER === "cerebras") {
    url = CEREBRAS_URL; key = CEREBRAS_API_KEY; model = CEREBRAS_MODEL; name = "CEREBRAS";
  }
  if (!key) {
    throw new Error(`No ${name}_API_KEY. Put it in a .env file or set PROVIDER=ollama for local.`);
  }
  const body: any = {
    model,
    messages: [{ role: "user", content }],
    temperature: 0,
  };
  // Not all OpenRouter free models accept response_format; the prompt + parseJson
  // already enforce JSON, so only request it on providers that reliably support it.
  if (PROVIDER !== "openrouter") body.response_format = { type: "json_object" };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
      "User-Agent": "Mozilla/5.0 eway-ts/1.0",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const out: any = await res.json();
  return out.choices[0].message.content;
}

// Stream the Ollama response so slow (CPU) inference doesn't trip the client's
// time-to-first-byte timeout. Streaming sends headers immediately, then we
// concatenate the chunks into the full message content.
async function ollamaChat(messages: any[]): Promise<string> {
  const stream = await ollama.chat({
    model: OLLAMA_MODEL,
    messages,
    format: "json",
    options: { temperature: 0 },
    stream: true,
  });
  let out = "";
  for await (const part of stream) out += part.message.content;
  return out;
}

// ---------- public API ----------
export async function extractFields(imageBase64: string, mime = "image/jpeg"): Promise<any> {
  let cleanedBase64 = imageBase64;
  let cleanedMime = mime;
  let cleanupInfo = { cleaned: false, reason: "cleanup step failed — used the original upload" };
  try {
    const result = await cleanupImage(Buffer.from(imageBase64, "base64"));
    cleanedBase64 = result.buffer.toString("base64");
    cleanedMime = result.mime;
    cleanupInfo = { cleaned: result.cleaned, reason: result.reason };
  } catch (err: any) {
    // Cleanup is a best-effort enhancement, never a hard requirement —
    // fall back to the original upload rather than failing extraction.
    cleanupInfo = { cleaned: false, reason: `cleanup step threw: ${err?.message || err}` };
  }

  if (PROVIDER === "cerebras") {
    throw new Error(
      "Cerebras has no vision/image_url support — use extractFromText (OCR) with " +
      "PROVIDER=cerebras, or set PROVIDER=groq/openai/openrouter for image extraction."
    );
  }
  if (CLOUD_PROVIDERS.includes(PROVIDER)) {
    const content = [
      { type: "text", text: IMAGE_PROMPT },
      { type: "image_url", image_url: { url: `data:${cleanedMime};base64,${cleanedBase64}` } },
    ];
    return finish(parseJson(await cloudChat(content)), cleanupInfo);
  }
  // ollama
  const content = await ollamaChat([
    { role: "user", content: IMAGE_PROMPT, images: [cleanedBase64] },
  ]);
  return finish(parseJson(content), cleanupInfo);
}

export async function extractFromText(rawText: string): Promise<any> {
  if (TEXT_PROVIDERS.includes(PROVIDER)) {
    return finish(parseJson(await cloudChat(TEXT_PROMPT + (rawText || ""))));
  }
  const content = await ollamaChat([
    { role: "user", content: TEXT_PROMPT + (rawText || "") },
  ]);
  return finish(parseJson(content));
}
