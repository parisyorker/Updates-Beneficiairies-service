const express = require("express");
const { getPool } = require("../db");
const { validateBeneficiary, validateBeneficiaryUpdate } = require("../validators/beneficiary");
const { yoomeeQueue } = require("../jobs/queue");
const { idempotencyMiddleware } = require("../middleware/idempotency");
const { getYoomeeUserProfileByPhoneLast } = require("../services/yoomeeClient");

const router = express.Router();
const pool = getPool();

// Detect optional columns once (keeps compatibility with existing DBs)
let _columnsPromise;
async function getBeneficiaryColumns() {
  if (_columnsPromise) return _columnsPromise;
  _columnsPromise = (async () => {
    const [rows] = await pool.execute("SHOW COLUMNS FROM beneficiaries");
    const cols = new Set(rows.map((r) => String(r.Field || "")));
    return {
      hasBankBranchCode: cols.has("bank_branch_code"),
      hasBankBranchName: cols.has("bank_branch_name")
    };
  })().catch((e) => {
    console.error("Failed to read beneficiaries schema", e?.message);
    return { hasBankBranchCode: false, hasBankBranchName: false };
  });
  return _columnsPromise;
}

function isBranchRequiredCountry(country) {
  const allowed = (process.env.ALLOWED_COUNTRIES || "CM,GA,CG,TD")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  // Only enforce branch requirement within allowed countries
  if (!allowed.includes((country || "").toUpperCase())) return false;
  const required = (process.env.FLW_BRANCH_REQUIRED_COUNTRIES || "CM,GA,TD")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return required.includes((country || "").toUpperCase());
}

// Idempotency for unsafe methods (POST/PUT/DELETE)
router.use(idempotencyMiddleware({ requireKey: true }));

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// POST /beneficiaries
router.post("/", async (req, res) => {
  const validation = validateBeneficiary(req.body);
  if (!validation.ok) {
    return res.status(400).json({ ok: false, errors: validation.errors });
  }

  const b = validation.value;

  // For branch-required countries, require Flutterwave branch code when bank details are provided
  const bankDetailsProvided = b.bank_account_number && b.bank_code && b.bank_branch;
  if (bankDetailsProvided && isBranchRequiredCountry(b.country) && !b.bank_branch_code) {
    return res.status(400).json({
      ok: false,
      errors: {
        formErrors: [
          `bank_branch_code is required for country ${(b.country || "").toUpperCase()} when bank details are provided`
        ]
      }
    });
  }

  try {
    const cols = await getBeneficiaryColumns();
    const insertCols = [
      "firstname",
      "lastname",
      "country",
      "bank_account_number",
      "bank_code",
      "bank_branch"
    ];
    const insertVals = [
      b.firstname,
      b.lastname,
      b.country,
      b.bank_account_number ?? null,
      b.bank_code ?? null,
      b.bank_branch ?? null
    ];

    if (cols.hasBankBranchCode) {
      insertCols.push("bank_branch_code");
      insertVals.push(b.bank_branch_code ?? null);
    }

    if (cols.hasBankBranchName) {
      insertCols.push("bank_branch_name"); 
      insertVals.push(b.bank_branch_name ?? null);
    }

    insertCols.push(
      "mobile_money_network",
      "mobile_money_country",
      "mobile_money_phone_number",
      "yoomee_account_number",
      "yoomee_account_group",
      "contactbook_owner_phone_number"
    );
    insertVals.push(
      b.mobile_money_network ?? null,
      b.mobile_money_country ?? null,
      b.mobile_money_phone_number,
      null,
      null,
      b.contactbook_owner_phone_number
    );

    const placeholders = insertCols.map(() => "?").join(", ");
    const sql = `INSERT INTO beneficiaries (${insertCols.join(", ")}) VALUES (${placeholders})`;
    const params = insertVals;

    const [result] = await pool.execute(sql, params);
    const beneficiaryId = result.insertId;

    await yoomeeQueue.add(
      "resolve-yoomee",
      { beneficiaryId, phone: b.mobile_money_phone_number },
      {
        attempts: 5,
        backoff: { type: "exponential", delay: 3000 },
        removeOnComplete: 2000,
        removeOnFail: 2000
      }
    );

    return res.status(200).json({
      ok: true,
      id: beneficiaryId,
      message: "Beneficiary saved. Yoomee resolution started."
    });
  } catch (err) {
    if (err && err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        ok: false,
        error: "Beneficiary already exists for this owner and mobile money phone number."
      });
    }

    console.error(err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// GET /beneficiaries?owner=...&page=1&limit=20
router.get("/", async (req, res) => {
  const owner = (req.query.owner || "").toString().trim();
  if (!owner) {
    return res.status(400).json({ ok: false, error: "owner query param is required" });
  }

  /*const page = Math.max(1, toInt(req.query.page, 1));
  const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 20)));
  const offset = (page - 1) * limit;*/

const page = Math.max(1, parseInt(req.query.page ?? "1", 10));
const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? "20", 10)));
const offset = (page - 1) * limit;

  const [[countRow]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM beneficiaries WHERE contactbook_owner_phone_number = ?`,
    [owner]
  );
  const total = Number(countRow.total || 0);
  const totalPages = total === 0 ? 1 : Math.ceil(total / limit);

  /*const [rows] = await pool.execute(
    `SELECT * FROM beneficiaries
     WHERE contactbook_owner_phone_number = ?
     ORDER BY id DESC
     LIMIT ? OFFSET ?`,
    [owner, limit, offset]
  );*/

  const [rows] = await pool.execute(
  `SELECT * FROM beneficiaries
   WHERE contactbook_owner_phone_number = ?
   ORDER BY id DESC
   LIMIT ${limit} OFFSET ${offset}`,
  [owner]
);

  return res.status(200).json({
    ok: true,
    page,
    limit,
    total,
    total_pages: totalPages,
    data: rows
  });
});

// GET /beneficiaries/yoomee/user?phone=+2376...
// Returns basic profile fields from Yoomee by performing a keyword search.
router.get("/yoomee/user", async (req, res) => {
  const phone = (req.query.phone || "").toString().trim();
  if (!phone) {
    return res.status(400).json({ ok: false, error: "phone query param is required" });
  }

  try {
    const profile = await getYoomeeUserProfileByPhoneLast(phone);
    if (!profile) {
      return res.status(404).json({ ok: false, error: "Yoomee user not found" });
    }

    return res.status(200).json({ ok: true, data: profile });
  } catch (err) {
    console.error("Yoomee profile lookup failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// GET /beneficiaries/:id
router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ ok: false, error: "Invalid id" });
  }

  const [rows] = await pool.execute(`SELECT * FROM beneficiaries WHERE id = ?`, [id]);
  if (!rows.length) {
    return res.status(404).json({ ok: false, error: "Not found" });
  }

  return res.status(200).json({ ok: true, data: rows[0] });
});

// PUT /beneficiaries/:id
// Body must include contactbook_owner_phone_number for authorization
router.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ ok: false, error: "Invalid id" });
  }

  const validation = validateBeneficiaryUpdate(req.body);
  if (!validation.ok) {
    return res.status(400).json({ ok: false, errors: validation.errors });
  }

  const b = validation.value;

  // Fetch existing row, ensure it belongs to owner
  const [rows] = await pool.execute(
    `SELECT * FROM beneficiaries WHERE id = ? AND contactbook_owner_phone_number = ? LIMIT 1`,
    [id, b.contactbook_owner_phone_number]
  );

  if (!rows.length) {
    return res.status(404).json({ ok: false, error: "Not found" });
  }

  const existing = rows[0];

  // Only update fields explicitly provided
  const updates = {
    firstname: Object.prototype.hasOwnProperty.call(req.body, "firstname") ? b.firstname : existing.firstname,
    lastname: Object.prototype.hasOwnProperty.call(req.body, "lastname") ? b.lastname : existing.lastname,
    country: Object.prototype.hasOwnProperty.call(req.body, "country") ? b.country : existing.country,

    bank_account_number: Object.prototype.hasOwnProperty.call(req.body, "bank_account_number") ? b.bank_account_number : existing.bank_account_number,
    bank_code: Object.prototype.hasOwnProperty.call(req.body, "bank_code") ? b.bank_code : existing.bank_code,
    bank_branch: Object.prototype.hasOwnProperty.call(req.body, "bank_branch") ? b.bank_branch : existing.bank_branch,
    bank_branch_code: Object.prototype.hasOwnProperty.call(req.body, "bank_branch_code") ? b.bank_branch_code : existing.bank_branch_code,
    bank_branch_name: Object.prototype.hasOwnProperty.call(req.body, "bank_branch_name") ? b.bank_branch_name : existing.bank_branch_name,

    mobile_money_network: Object.prototype.hasOwnProperty.call(req.body, "mobile_money_network") ? b.mobile_money_network : existing.mobile_money_network,
    mobile_money_country: Object.prototype.hasOwnProperty.call(req.body, "mobile_money_country") ? b.mobile_money_country : existing.mobile_money_country,
    mobile_money_phone_number: Object.prototype.hasOwnProperty.call(req.body, "mobile_money_phone_number") ? b.mobile_money_phone_number : existing.mobile_money_phone_number
  };

  const phoneChanged =
    Object.prototype.hasOwnProperty.call(req.body, "mobile_money_phone_number") &&
    updates.mobile_money_phone_number !== existing.mobile_money_phone_number;

  try {
    const cols = await getBeneficiaryColumns();

    // If bank details are cleared, also clear Flutterwave branch fields
    const bankCleared =
      updates.bank_account_number == null && updates.bank_code == null && updates.bank_branch == null;
    const branchKeysProvided =
      Object.prototype.hasOwnProperty.call(req.body, "bank_branch_code") ||
      Object.prototype.hasOwnProperty.call(req.body, "bank_branch_name");

    const bankCoreChanged =
      updates.bank_account_number !== existing.bank_account_number ||
      updates.bank_code !== existing.bank_code ||
      updates.bank_branch !== existing.bank_branch;

    if (bankCleared) {
      updates.bank_branch_code = null;
      updates.bank_branch_name = null;
    } else if (bankCoreChanged && !branchKeysProvided) {
      // If bank changes and caller didn't explicitly set branch fields, clear them to force re-selection
      updates.bank_branch_code = null;
      updates.bank_branch_name = null;
    }

    // Enforce branch code rules for the final state (only when related fields are being changed)
    const bankDetailsProvided = updates.bank_account_number && updates.bank_code && updates.bank_branch;
    const countryTouched = Object.prototype.hasOwnProperty.call(req.body, "country");
    const bankCoreTouched =
      Object.prototype.hasOwnProperty.call(req.body, "bank_account_number") ||
      Object.prototype.hasOwnProperty.call(req.body, "bank_code") ||
      Object.prototype.hasOwnProperty.call(req.body, "bank_branch");
    const enforceBranch = countryTouched || bankCoreTouched || branchKeysProvided;

    if (enforceBranch && bankDetailsProvided && isBranchRequiredCountry(updates.country) && !updates.bank_branch_code) {
      return res.status(400).json({
        ok: false,
        errors: {
          formErrors: [
            `bank_branch_code is required for country ${(updates.country || "").toUpperCase()} when bank details are provided`
          ]
        }
      });
    }
    if (enforceBranch && updates.bank_branch_name && !updates.bank_branch_code) {
      return res.status(400).json({
        ok: false,
        errors: { formErrors: ["bank_branch_code is required when bank_branch_name is provided"] }
      });
    }

    const yoomeeAccountNumber = phoneChanged ? null : existing.yoomee_account_number;
    const yoomeeAccountGroup = phoneChanged ? null : existing.yoomee_account_group;

    const setParts = [
      "firstname = ?",
      "lastname = ?",
      "country = ?",
      "bank_account_number = ?",
      "bank_code = ?",
      "bank_branch = ?",
      "mobile_money_network = ?",
      "mobile_money_country = ?",
      "mobile_money_phone_number = ?",
      "yoomee_account_number = ?",
      "yoomee_account_group = ?"
    ];
    const params = [
      updates.firstname,
      updates.lastname,
      updates.country,
      updates.bank_account_number ?? null,
      updates.bank_code ?? null,
      updates.bank_branch ?? null,
      updates.mobile_money_network ?? null,
      updates.mobile_money_country ?? null,
      updates.mobile_money_phone_number ?? null,
      yoomeeAccountNumber,
      yoomeeAccountGroup
    ];

    if (cols.hasBankBranchCode) {
      setParts.push("bank_branch_code = ?");
      params.push(updates.bank_branch_code ?? null);
    }
    if (cols.hasBankBranchName) {
      setParts.push("bank_branch_name = ?");
      params.push(updates.bank_branch_name ?? null);
    }

    const sql = `UPDATE beneficiaries SET ${setParts.join(", ")} WHERE id = ? AND contactbook_owner_phone_number = ?`;
    params.push(id, b.contactbook_owner_phone_number);

    const [result] = await pool.execute(sql, params);
    if (result.affectedRows === 0) {
      return res.status(404).json({ ok: false, error: "Not found" });
    }

    if (phoneChanged && updates.mobile_money_phone_number) {
      await yoomeeQueue.add(
        "resolve-yoomee",
        { beneficiaryId: id, phone: updates.mobile_money_phone_number },
        {
          attempts: 5,
          backoff: { type: "exponential", delay: 3000 },
          removeOnComplete: 2000,
          removeOnFail: 2000
        }
      );
    }

    return res.status(200).json({
      ok: true,
      id,
      message: phoneChanged
        ? "Beneficiary updated. Yoomee resolution restarted due to phone change."
        : "Beneficiary updated."
    });
  } catch (err) {
    if (err && err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        ok: false,
        error: "Update would create a duplicate beneficiary for this owner and mobile money phone number."
      });
    }
    console.error(err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// DELETE /beneficiaries/:id?owner=...
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ ok: false, error: "Invalid id" });
  }

  const owner = (req.query.owner || "").toString().trim();
  if (!owner) {
    return res.status(400).json({ ok: false, error: "owner query param is required" });
  }

  try {
    const [result] = await pool.execute(
      `DELETE FROM beneficiaries WHERE id = ? AND contactbook_owner_phone_number = ?`,
      [id, owner]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ ok: false, error: "Not found" });
    }

    return res.status(200).json({ ok: true, message: "Beneficiary deleted." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

module.exports = router;
