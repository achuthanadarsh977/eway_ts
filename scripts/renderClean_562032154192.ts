/**
 * Render a clean, print-quality PDF of EWB 562032154192 from the verified
 * data (see outputs/562032154192.json), using the real pdfBuilder now that
 * it supports eway_bill_status and irn_details natively.
 */
import fs from "fs";
import path from "path";
import { renderPdfBuffer } from "../src/pdfBuilder";

const DATA = {
  document_type: "E-Way Bill",
  eway_bill_no: "562032154192",
  eway_bill_status: "EWB (Active)",
  summary: {
    eway_bill_date: "04/07/2026 08:16:00 PM",
    generated_by: { gstin: "33AABCG3365J1ZP", name: "Godrej Consumer Products Ltd" },
    valid_from: "04/07/2026 08:16:00 PM",
    distance_km: 548,
    valid_until: "07/07/2026",
    portal: "1",
  },
  irn_details: {
    irn: "529c241ceb5be4f0a54aa3e9cc95f7474a2daaf503129c8a870b2bbbcf557846",
    irn_date: "04/07/2026 08:16:00 PM",
    ack_no: "152626321182645",
  },
  part_a: {
    supplier: { gstin: "33AABCG3365J1ZP", name: "Godrej Consumer Products Ltd" },
    place_of_dispatch:
      "PANCHAVADI, RS NO 25/1A1A, ANNA NAGAR, ACHARAMPATTUL, village Thiruchitrambalam Post, Vanur Taluk, Villupuram, TAMIL NADU, 605111",
    recipient: { gstin: "32AABCG3365J1ZR", name: "Godrej Consumer Products Ltd-Cochin" },
    place_of_delivery:
      "Building No XXI/727, Nochima Nad PO, Aluva, Cochin-683563, Aluva, KERALA, 683563",
    document_no: "BOSTN35200221",
    document_date: "04/07/2026",
    transaction_type: "Regular",
    value_of_goods: 20160.0,
    hsn_code: "40141010",
    hsn_description: "KS10'S RIBBED M100 P480 NEWAW",
    reason_for_transportation: "Outward - Supply",
    transporter: { id: "09AASCS0150N1ZU", name: "S S FORWARDERS PRIVATE LIMITED" },
  },
  part_b: [
    {
      mode: "Road",
      vehicle_trans_doc_no_and_dt: "TN72CL6728 / 66111 & 04/07/2026",
      from: "Villupuram",
      entered_date: "04/07/2026 08:16:00 PM",
      entered_by: "33AABCG3365J1ZP",
      cewb_no: null,
      multi_vehicle_info: null,
      portal: "1",
    },
  ],
  barcode_value: "562032154192",
};

(async () => {
  const outPath = path.join("C:", "Users", "SriniAchuthan", "Downloads", "562032154192_clean.pdf");
  const buf = await renderPdfBuffer(DATA);
  fs.writeFileSync(outPath, buf);
  console.log("Wrote:", outPath);
})();
