// Added: photo upload (6-12 required), reg-no/VIN validation, listable covers, purchase history
const express = require("express"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const db = require("../config/db"), auth = require("../middleware/authMiddleware");
const router = express.Router(), DIR = path.join(__dirname, "..", "uploads");
fs.mkdirSync(DIR, { recursive: true });

const STATES = new Set("AN AP AR AS BR CH CG DD DL DN GA GJ HP HR JH JK KA KL LA LD MH ML MN MP MZ NL OD OR PB PY RJ SK TN TR TS UK UP UA WB".split(" "));
const regOk = r => {
  if (/^\d{2}BH\d{4}[A-Z]{2}$/.test(r)) return true;                    // Bharat series: 22BH1234AA
  const m = r.match(/^([A-Z]{2})(\d{2})([A-Z]{1,3})(\d{4})$/);           // MH12AB1234
  return !!m && STATES.has(m[1]) && m[2] !== "00" && m[4] !== "0000";
};
const vinOk = v => /^[A-HJ-NPR-Z0-9]{17}$/.test(v);                      // 17 chars, no I/O/Q

router.use((req, res, next) => {
  const create = req.method === "POST" && req.path === "/";
  if (create || (req.method === "PUT" && /^\/[^/]+$/.test(req.path))) {
    const b = req.body || {};
    if (b.reg_no) b.reg_no = String(b.reg_no).toUpperCase().replace(/[\s-]/g, "");
    if (create && !b.reg_no) return res.status(400).json({ success: false, message: "Registration number is required" });
    if (b.reg_no && !regOk(b.reg_no)) return res.status(400).json({ success: false, message: "Invalid registration number. Example: MH12AB1234" });
    if (b.vin) { b.vin = String(b.vin).toUpperCase().replace(/\s/g, ""); if (!vinOk(b.vin)) return res.status(400).json({ success: false, message: "VIN must be 17 letters/digits (no I, O or Q)" }); }
  }
  next();
});

router.get("/listable", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT vehicle_id, COUNT(*) n,
              SUBSTRING_INDEX(GROUP_CONCAT(image_url ORDER BY is_primary DESC, sort_order, id SEPARATOR '|'),'|',1) cover
       FROM vehicle_images GROUP BY vehicle_id HAVING n >= 6`);
    const covers = {}; rows.forEach(r => covers[r.vehicle_id] = r.cover);
    res.json({ success: true, covers });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: "Failed to load photos" }); }
});

router.get("/my-purchases", auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT p.id, p.vehicle_id, p.purchase_price, p.status, p.purchased_at, v.title, v.make, v.model, v.year, v.sale_type
       FROM vehicle_purchases p INNER JOIN vehicles v ON v.id = p.vehicle_id
       WHERE p.buyer_id = ? ORDER BY p.purchased_at DESC`, [req.user.userId]);
    res.json({ success: true, purchases: rows });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: "Failed to load purchases" }); }
});

router.post("/:id/images", auth, async (req, res) => {
  const fail = (c, m) => res.status(c).json({ success: false, message: m });
  try {
    const id = req.params.id;
    const [v] = await db.query("SELECT seller_id FROM vehicles WHERE id = ?", [id]);
    if (!v.length) return fail(404, "Vehicle not found");
    if (Number(v[0].seller_id) !== Number(req.user.userId)) return fail(403, "Not your vehicle");
    const imgs = Array.isArray(req.body.images) ? req.body.images : [];
    const [[{ c }]] = await db.query("SELECT COUNT(*) c FROM vehicle_images WHERE vehicle_id = ?", [id]);
    if (c + imgs.length < 6 || c + imgs.length > 12) return fail(400, "Upload between 6 and 12 photos");
    const parsed = [];
    for (const s of imgs) {
      const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(s || "");
      if (!m) return fail(400, "Only JPG, PNG or WEBP images are allowed");
      const buf = Buffer.from(m[2], "base64");
      if (buf.length > 3 * 1024 * 1024) return fail(400, "Each photo must be under 3 MB");
      parsed.push({ buf, ext: m[1] === "jpeg" ? "jpg" : m[1] });
    }
    for (let i = 0; i < parsed.length; i++) {
      const name = `${id}-${crypto.randomBytes(6).toString("hex")}.${parsed[i].ext}`;
      fs.writeFileSync(path.join(DIR, name), parsed[i].buf);
      await db.query("INSERT INTO vehicle_images (vehicle_id, image_url, is_primary, sort_order) VALUES (?,?,?,?)",
        [id, "/uploads/" + name, c + i === 0 ? 1 : 0, c + i]);
    }
    res.status(201).json({ success: true, count: c + parsed.length });
  } catch (e) { console.error("Upload error:", e); fail(500, "Failed to upload photos"); }
});


// ---- Sale info: who bought a vehicle, for how much, and how (Auction / Buy It Now) ----
async function salesFor(ids) {
  if (!ids.length) return {};
  const [p] = await db.query(
    `SELECT p.vehicle_id, p.purchase_price, p.purchased_at, p.buyer_id, u.name
     FROM vehicle_purchases p INNER JOIN users u ON u.id = p.buyer_id WHERE p.vehicle_id IN (?)`, [ids]);
  const [a] = await db.query(
    `SELECT vehicle_id, current_bid, settled_at, high_bidder, high_bidder_id
     FROM auctions WHERE settlement_status = 'completed' AND vehicle_id IN (?)`, [ids]);
  const out = {}, won = {};
  a.forEach(x => { won[x.vehicle_id + "|" + x.high_bidder_id] = 1;
    out[x.vehicle_id] = { buyer_name: x.high_bidder, price: Number(x.current_bid), method: "Auction", sold_at: x.settled_at }; });
  p.forEach(x => { out[x.vehicle_id] = { buyer_name: x.name, price: Number(x.purchase_price),
    method: won[x.vehicle_id + "|" + x.buyer_id] ? "Auction" : "Buy It Now", sold_at: x.purchased_at }; });
  return out;
}
router.get("/my-sales", auth, async (req, res) => {
  try {
    const [v] = await db.query("SELECT id FROM vehicles WHERE seller_id = ?", [req.user.userId]);
    res.json({ success: true, sales: await salesFor(v.map(x => x.id)) });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: "Failed to load sales" }); }
});
router.get("/:id/sale", async (req, res) => {
  try { const m = await salesFor([req.params.id]); res.json({ success: true, sale: m[req.params.id] || null }); }
  catch (e) { console.error(e); res.status(500).json({ success: false, message: "Failed to load sale" }); }
});

module.exports = router;
