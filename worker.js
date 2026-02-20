require("dotenv").config();

const { Worker } = require("bullmq");
const { getConnection } = require("./queue");
const { getPool } = require("../db");
const { resolveGetYoomeeByPhone } = require("../services/yoomeeClient");

const pool = getPool();

async function updateBeneficiaryYoomee(id, fields) {
  const sql = `
    UPDATE beneficiaries
    SET yoomee_account_number = ?,
        yoomee_account_group = ?
    WHERE id = ?
  `;
  await pool.execute(sql, [fields.yoomee_account_number, fields.yoomee_account_group, id]);
}

const worker = new Worker(
  "yoomee-resolution",
  async (job) => {
    const { beneficiaryId, phone } = job.data;

    // Resolve Yoomee group fields from Yoomee APIs
    const yoomee = await resolveGetYoomeeByPhone(phone);
    if (!yoomee) {
      return { updated: false, reason: "no-match" };
    }

    await updateBeneficiaryYoomee(beneficiaryId, yoomee);
    return { updated: true, ...yoomee };
  },
  {
    connection: getConnection(),
    concurrency: 5
  }
);

worker.on("completed", (job, result) => {
  console.log("Yoomee job completed", job.id, result);
});

worker.on("failed", (job, err) => {
  console.error("Yoomee job failed", job?.id, err?.message);
});

console.log("Yoomee worker started...");
