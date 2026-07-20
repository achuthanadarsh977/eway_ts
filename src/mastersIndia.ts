/**
 * Reshape the extracted e-Way Bill JSON into the same shape as
 * get_ewb_details_from_masters_india (so Deluge can consume it directly).
 * Ported from app.py.
 */

export function safeName(s: any): string {
  const keep = String(s ?? "")
    .split("")
    .map((ch) => (/[A-Za-z0-9 \-_]/.test(ch) ? ch : "_"))
    .join("");
  return keep.trim() || "eway";
}

export function digits(s: any): string {
  return String(s ?? "").replace(/[^0-9]/g, "");
}

function pincode(place: any): number | string {
  const m = String(place ?? "").match(/(\d{6})/);
  return m ? parseInt(m[1], 10) : place || "";
}

function vehicleNo(token: any): string {
  if (!token) return "";
  let t = String(token);
  for (const sep of [" ", "&"]) {
    if (t.includes(sep)) t = t.split(sep)[0];
  }
  return t.trim().replace(/-/g, "").toUpperCase();
}

// e-Way Bill dates are IST wall-clock time with no offset marker (e.g.
// "07/07/2026" or "05/07/2026 11:59 PM"). Parse as IST and return the
// equivalent UTC instant so it compares correctly against Date.now()
// regardless of the server's local timezone.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function parseEwbDateIST(s: any): Date | null {
  if (!s) return null;
  const m = String(s)
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM)?)?/i);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min, ampm] = m;
  // No time on the document means "valid through end of that day".
  let hour = hh ? parseInt(hh, 10) : 23;
  const minute = hh ? parseInt(min, 10) : 59;
  const second = hh ? 0 : 59;
  if (ampm) {
    const isPM = ampm.toUpperCase() === "PM";
    if (isPM && hour !== 12) hour += 12;
    if (!isPM && hour === 12) hour = 0;
  }
  const utcMs =
    Date.UTC(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10), hour, minute, second) -
    IST_OFFSET_MS;
  const date = new Date(utcMs);
  return isNaN(date.getTime()) ? null : date;
}

// "ACT" if valid_until is still in the future (or now), "CAN" if it has
// already passed. Empty string (not a guess) if valid_until is missing
// or unparseable.
export function computeEwbStatus(validUntil: any): "ACT" | "CAN" | "" {
  const until = parseEwbDateIST(validUntil);
  if (!until) return "";
  return until.getTime() < Date.now() ? "CAN" : "ACT";
}

export function toMastersIndia(data: any): any {
  data = data || {};
  const summary = data.summary || {};
  const partA = data.part_a || {};
  const partB = data.part_b || [];
  const gen = summary.generated_by || {};
  const sup = partA.supplier || {};
  const rec = partA.recipient || {};
  const tr = partA.transporter || {};

  const vehicles = (partB || []).map((ent: any) => {
    ent = ent || {};
    return {
      enteredDate: ent.entered_date,
      vehicleNo: vehicleNo(ent.vehicle_trans_doc_no_and_dt),
    };
  });

  const ewbDigits = digits(data.eway_bill_no);
  return {
    ewbNo: ewbDigits ? parseInt(ewbDigits, 10) : 0,
    ewayBillDate: summary.eway_bill_date,
    validUpto: summary.valid_until,
    status: computeEwbStatus(summary.valid_until),
    fromPincode: pincode(partA.place_of_dispatch),
    toPincode: pincode(partA.place_of_delivery),
    userGstin: gen.gstin,
    consignorGst: sup.gstin,
    consigneeGst: rec.gstin,
    transporterGst: tr.id,
    VehiclListDetails: vehicles,
  };
}
