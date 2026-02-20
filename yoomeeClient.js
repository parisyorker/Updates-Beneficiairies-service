const axios = require("axios");

function buildBasicAuthHeader() {
  const username = process.env.YOOMEE_USERNAME;
  const password = process.env.YOOMEE_PASSWORD;
  if (!username || !password) {
    throw new Error("YOOMEE_USERNAME and YOOMEE_PASSWORD must be set");
  }
  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

function yoomeeHttp() {
  const baseURL = process.env.YOOMEE_BASE_URL;
  if (!baseURL) {
    throw new Error("YOOMEE_BASE_URL must be set");
  }

  const Authorization = buildBasicAuthHeader();

  return axios.create({
    baseURL,
    timeout: 120000,
    headers: {
      accept: "application/json",
      Authorization
    }
  });
}

function yoomeeGetHttp() {
  const baseURL = process.env.YOOMEE_BASE_URL;
  if (!baseURL) {
    throw new Error("YOOMEE_BASE_URL must be set");
  }

  return axios.create({
    baseURL,
    timeout: 20000,
    headers: {
      accept: "application/json",
      Authorization : "Basic d2ljYXNoX2dldFVzZXJEZXRhaWxzOndpY2FzaF9nZXRVc2VyRGV0YWlscw=="
    }
  });
}

function normalizePhone(p) {
  if (!p) return "";
  // Keep leading + if present; remove spaces, hyphens, parentheses
  return String(p).trim().replace(/[\s\-()]/g, "");
}

/**
 * Build candidate variants for search:
 * - If input is +237XXXXXXXXX => also try XXXXXXXXX
 * - If input is XXXXXXXXX => also try +237XXXXXXXXX (when we can infer CC)
 *
 * You can extend CC inference by country if you have it.
 * For now:
 *  - If phone starts with +<digits> -> strip to local
 *  - If phone is local (no +) and YOOMEE_DEFAULT_COUNTRY_CODE is set, prefix it
 */
function buildPhoneVariants(inputPhone) {
  const raw = normalizePhone(inputPhone);
  if (!raw) return [];

  const variants = new Set();

  // As-is
  variants.add(raw);

  // Remove leading '+'
  if (raw.startsWith("+")) variants.add(raw.slice(1));

  // If +237xxxxxxxxx => also add local without country code
  // We can't perfectly know local length for every country, but for Yoomee keyword search,
  // trying the remainder is useful.
  if (raw.startsWith("+") && raw.length > 4) {
    // Try stripping first 4 chars like +237 (Cameroon) when matches pattern +[0-9]{3}
    const m = raw.match(/^\+(\d{1,3})(\d+)$/);
    if (m) {
      const cc = m[1];
      const rest = m[2];
      variants.add(rest);          // local part
      variants.add(cc + rest);     // without '+'
      variants.add("+" + cc + rest); // normalized again
    }
  }

  // If local (no +) and we have a default CC, try adding it
  if (!raw.startsWith("+")) {
    const defaultCC = String(process.env.YOOMEE_DEFAULT_COUNTRY_CODE || "").trim(); // e.g. "237"
    if (defaultCC) {
      // If raw already starts with CC (e.g. 2376...), still try +CC and raw
      const noPlus = raw.startsWith(defaultCC) ? raw : `${defaultCC}${raw}`;
      variants.add(noPlus);
      variants.add("+" + noPlus);
    }
  }

  return Array.from(variants).filter(Boolean);
}

function pickBestUserFromSearchResults(results, candidatePhones) {
  // Yoomee search endpoint may return:
  // - Array of users
  // - Single user object
  // - Object envelope { data: [...] }
  const list = Array.isArray(results)
    ? results
    : (results && typeof results === "object" && Array.isArray(results.data))
      ? results.data
      : (results && typeof results === "object" && results.id)
        ? [results]
        : [];

  if (!Array.isArray(list) || list.length === 0) return null;

  const targets = new Set(
    (Array.isArray(candidatePhones) ? candidatePhones : [candidatePhones])
      .map(normalizePhone)
      .filter(Boolean)
  );

  // Prefer exact match on customValues.ContactPhone
  const byContactPhone = list.find((u) => targets.has(normalizePhone(u?.customValues?.ContactPhone)));
  if (byContactPhone) return byContactPhone;

  // Next, try matching `phone`
  const byPhone = list.find((u) => targets.has(normalizePhone(u?.phone)));
  if (byPhone) return byPhone;

  // Fallback to first element
  return list[0];
}

function extractBirthdateFromCustomValues(customValues) {
  if (!Array.isArray(customValues) || customValues.length === 0) return null;

  // Prefer matching by internalName when available
  const byInternalName = customValues.find(
    (cv) => cv?.dateValue && (cv?.field?.internalName === "Bornon" || cv?.field?.internalName === "bornOn")
  );
  if (byInternalName?.dateValue) return String(byInternalName.dateValue);

  // Fallback to index 2 as requested (if present)
  const idx = customValues[2];
  if (idx?.dateValue) return String(idx.dateValue);

  // Fallback to first dateValue found
  const anyDate = customValues.find((cv) => cv?.dateValue);
  return anyDate?.dateValue ? String(anyDate.dateValue) : null;
}

function mapYoomeeUserToProfile(u) {
  const addr = Array.isArray(u?.addresses) && u.addresses.length ? u.addresses[0] : null;
  return {
    name: u?.name ?? null,
    email: u?.email ?? null,
    city: addr?.city ?? null,
    countrycode: addr?.country ?? null,
    birthdate: extractBirthdateFromCustomValues(u?.customValues),
    address: addr?.neighborhood ?? null
  };
}

async function resolveYoomeeByPhone(phone) {
  const http = yoomeeHttp();

  const variants = buildPhoneVariants(phone);
  if (variants.length === 0) return null;

  let user = null;

  // Try each variant until we get a hit
  for (const v of variants) {
    // IMPORTANT: encode '+' as '%2B' - encodeURIComponent handles that
    const keywords = encodeURIComponent(v);
    const searchUrl = `/api/users?keywords=${keywords}&statuses=active`;

    const searchResp = await http.get(searchUrl);
    if (searchResp.status !== 200) continue;

    user = pickBestUserFromSearchResults(searchResp.data, variants);
    if (user?.id) break;
  }

  const userId = user?.id;
  if (!userId) return null;

  // Fetch user details
  const detailResp = await http.get(`/api/users/${encodeURIComponent(String(userId))}`);
  if (detailResp.status !== 200) return null;

  const u = detailResp.data;

  const groupId = u?.group?.id ?? null;
  const groupInternalName = u?.group?.internalName ?? null;

  if (!groupId || !groupInternalName) return null;

  return {
    yoomee_account_number: String(userId),
    yoomee_account_group: String(groupInternalName)
  };
}

async function resolveGetYoomeeByPhone(phone) {
  const http = yoomeeGetHttp();

  // 1) Search user by keywords (phone). IMPORTANT: encode '+' as '%2B'
  const keywords = encodeURIComponent(phone);

  const detailResp = await http.get(`/run/api/wicash/getuser/${keywords}`);
  if (detailResp.status !== 200) return null;

  const u = detailResp.data;

  // From sample: group.id and group.internalName
  const groupId = u?.account_number ?? null;
  const groupInternalName = u?.group_internal_name ?? null;

  if (!groupId || !groupInternalName) return null;

  return {
    yoomee_account_number: String(groupId),
    yoomee_account_group: String(groupInternalName)
  };
}

/**
 * Retrieve Yoomee user profile (name/email/address/birthdate) by phone keyword.
 * Uses the same keyword search strategy as resolveYoomeeByPhone.
 */
async function getYoomeeUserProfileByPhone(phone) {
  const http = yoomeeHttp();

  const variants = buildPhoneVariants(phone);
  if (variants.length === 0) return null;

  let user = null;

  for (const v of variants) {
    const keywords = encodeURIComponent(v);
    const searchUrl = `/api/users?keywords=${keywords}&statuses=active`;

    const searchResp = await http.get(searchUrl);
    if (searchResp.status !== 200) continue;

    user = pickBestUserFromSearchResults(searchResp.data, variants);
    if (user?.id) break;
  }

  const userId = user?.id;
  if (!userId) return null;

  // The search response might not include addresses/customValues.
  const hasNeededFields =
    Array.isArray(user?.addresses) &&
    user.addresses.length > 0 &&
    Array.isArray(user?.customValues) &&
    user.customValues.length > 0;

  let fullUser = user;
  if (!hasNeededFields) {
    const detailResp = await http.get(`/api/users/${encodeURIComponent(String(userId))}`);
    if (detailResp.status !== 200) return null;
    fullUser = detailResp.data;
  }

  return mapYoomeeUserToProfile(fullUser);
}


async function getYoomeeUserProfileByPhoneLast(phone) {
  const http = yoomeeGetHttp();
  const httpx = yoomeeHttp();

    const keywords = encodeURIComponent(phone);
    const searchUrl = `/run/api/wicash/getuser/${keywords}`;

    const searchResp = await http.get(searchUrl);
    if (searchResp.status !== 200) return null;

  const userId = searchResp.data.account_number;
  if (!userId) return null;

    const detailResp = await httpx.get(`/api/users/${encodeURIComponent(String(userId))}`);
    if (detailResp.status !== 200) return null;
    fullUser = detailResp.data;
  
  return mapYoomeeUserToProfile(fullUser);
}

module.exports = { resolveGetYoomeeByPhone, getYoomeeUserProfileByPhoneLast };
