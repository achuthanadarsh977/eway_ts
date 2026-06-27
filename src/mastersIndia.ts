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
    status: "",
    fromPincode: pincode(partA.place_of_dispatch),
    toPincode: pincode(partA.place_of_delivery),
    userGstin: gen.gstin,
    consignorGst: sup.gstin,
    consigneeGst: rec.gstin,
    transporterGst: tr.id,
    VehiclListDetails: vehicles,
  };
}
