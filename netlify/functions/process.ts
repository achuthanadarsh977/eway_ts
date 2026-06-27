/**
 * Netlify Function: POST /process
 * Body: JSON { image_base64: string, mime?: string }
 * Returns JSON with the extracted data, Masters-India shape, and the PDF inline (base64).
 */
import type { Handler } from "@netlify/functions";
import { extractFields } from "../../src/llmExtract";
import { renderPdfBuffer } from "../../src/pdfBuilder";
import { toMastersIndia } from "../../src/mastersIndia";

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers, body: JSON.stringify({ status: false, message: "Method not allowed." }) };

  try {
    const body = JSON.parse(event.body || "{}");
    let b64: string = body.image_base64 || "";
    const mime: string = body.mime || "image/jpeg";
    if (!b64.trim())
      return { statusCode: 400, headers, body: JSON.stringify({ status: false, message: "No image provided." }) };
    if (b64.includes(",") && b64.trim().toLowerCase().startsWith("data:")) b64 = b64.split(",")[1];

    const data = await extractFields(b64, mime);
    const ewbNo = String(data.eway_bill_no || Date.now());
    const pdfBuf = await renderPdfBuffer(data);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: true,
        message: "Extracted",
        ewb_no: ewbNo,
        json: data,
        data: toMastersIndia(data),
        pdf_base64: pdfBuf.toString("base64"),
      }),
    };
  } catch (e: any) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ status: false, message: `${e.name || "Error"}: ${e.message || e}` }),
    };
  }
};
