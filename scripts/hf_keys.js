// Main Hugging Face key creation flow.
// This script refreshes hCaptcha cookies when needed, creates a burner inbox,
// walks the Hugging Face signup flow, confirms the email, extracts the write
// token, and appends it to data/keys.txt.
"use strict";

// Patchright is a drop-in fork of Playwright that fixes the protocol-level
// detection leaks raw Playwright leaves open — most importantly the
// Runtime.enable / Console.enable CDP calls that Cloudflare, DataDome and
// hCaptcha fingerprint to spot automation. It also strips the automation
// launch flags (--enable-automation, --disable-extensions, etc.) for us.
// Same API as playwright, so the rest of the file is unchanged.
const { chromium } = require("patchright");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const ROOT_DIR = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT_DIR, ".env") });

// ─── Config ────────────────────────────────────────────────────────────────
// COOKIE_PATH is the single cookie cache that hc_cookie_refresh.js writes and
// ensureCookies() consumes before any signup attempt begins.
const COOKIE_PATH    = path.join(ROOT_DIR, "data", "hc_cookie.json");
const KEYS_PATH      = path.join(ROOT_DIR, "data", "keys.txt");
const REFRESH_SCRIPT = path.join(ROOT_DIR, "scripts", "hc_cookie_refresh.js");
const BURNER_SCRIPT  = path.join(ROOT_DIR, "scripts", "burner_email.py");
const HCAPTCHA_COOKIE_URLS = [
  "https://hcaptcha.com",
  "https://www.hcaptcha.com",
  "https://accounts.hcaptcha.com",
  "https://api.hcaptcha.com",
];
const CAPTCHA_BLOCK_EXIT_CODE = 2;
const HF_SIGNUP_URL = "https://huggingface.co/join";
const HCAPTCHA_FRAME_RE = /(^|:\/\/)([^/]+\.)?hcaptcha\.com/i;
const CAPTCHA_BODY_RE = /(select all|verify you are human|i'?m human|challenge|captcha|puzzle)/i;

// Chrome runs with a throwaway profile dir so the signup flow can be observed
// and cleaned up without disturbing the browser-strength profiles. Patchright
// talks to Chrome over a protocol pipe (not a network CDP port), so there's no
// remote-debugging-port to manage here — launchPersistentContext handles it.
const X_DISPLAY = ":1";
const CONFIRM_EMAIL_TIMEOUT = 20;
const COOKIE_PRIME_TIMEOUT = 12000;

// ─── Logging ───────────────────────────────────────────────────────────────
const ts   = () => new Date().toISOString().slice(11, 19);
const step = (msg) => console.log(`[${ts()}] › ${msg}`);
const ok   = (msg) => console.log(`[${ts()}] ✓ ${msg}`);
const fail = (msg) => console.error(`[${ts()}] ✗ ${msg}`);
const dbg  = (msg) => { if (process.env.DEBUG) console.log(`[${ts()}]   ${msg}`); };
const warn = (msg) => console.log(`[${ts()}] ⚠ ${msg}`);

const sleep      = (ms) => new Promise((r) => setTimeout(r, ms));
const humanDelay = (min = 500, max = 1200) => sleep(min + Math.random() * (max - min));

// ─── Generators ────────────────────────────────────────────────────────────
function generatePassword() {
  const lower   = "abcdefghijklmnopqrstuvwxyz";
  const upper   = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits  = "0123456789";
  const special = "!@#$%^&*()-_=+[]{}|;:,.<>?";
  const all     = lower + upper + digits + special;

  const guaranteed = [
    lower[Math.floor(Math.random() * lower.length)],
    lower[Math.floor(Math.random() * lower.length)],
    upper[Math.floor(Math.random() * upper.length)],
    upper[Math.floor(Math.random() * upper.length)],
    digits[Math.floor(Math.random() * digits.length)],
    digits[Math.floor(Math.random() * digits.length)],
    special[Math.floor(Math.random() * special.length)],
    special[Math.floor(Math.random() * special.length)],
  ];

  const rest = Array.from({ length: 8 }, () => all[Math.floor(Math.random() * all.length)]);

  const chars = [...guaranteed, ...rest];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join("");
}

function generateUsername() {
  const adj  = ["swift", "dark", "neon", "cyber", "lunar", "solar", "echo", "nova"];
  const noun = ["fox", "wolf", "hawk", "lynx", "bear", "crow", "viper", "ghost"];
  const num  = Math.floor(Math.random() * 9000 + 1000);
  return `${adj[Math.floor(Math.random() * adj.length)]}${noun[Math.floor(Math.random() * noun.length)]}${num}`;
}

function generateFullName() {
  const first = ["James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda"];
  const last  = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis"];
  return `${first[Math.floor(Math.random() * first.length)]} ${last[Math.floor(Math.random() * last.length)]}`;
}

// ─── 1. Cookie Check ──────────────────────────────────────────────────────
async function ensureCookies() {
  step("Checking hc_cookie.json...");
  let needsRefresh = false;

  if (!fs.existsSync(COOKIE_PATH)) {
    step("Cookie file missing.");
    needsRefresh = true;
  } else {
    const stats = fs.statSync(COOKIE_PATH);
    const ageMs = Date.now() - stats.mtimeMs;
    const hours = ageMs / (1000 * 60 * 60);
    if (hours > 24) {
      step(`Cookie is ${hours.toFixed(1)} hours old (>24h).`);
      needsRefresh = true;
    } else {
      ok(`Cookie is fresh (${hours.toFixed(1)}h old).`);
    }
  }

  if (needsRefresh) {
    // The refresh flow is expensive, so only rerun it when the cookie file is
    // missing or stale enough to be suspicious.
    step("Running hc_cookie_refresh.js...");
    try {
      execSync(`node ${REFRESH_SCRIPT}`, { stdio: "inherit" });
      ok("Cookie refreshed.");
    } catch (e) {
      fail("Failed to refresh cookie.");
      process.exit(1);
    }
  }

  const data = JSON.parse(fs.readFileSync(COOKIE_PATH, "utf-8"));
  // Support both the old single-cookie format and the current array format.
  return Array.isArray(data) ? data : [data];
}

// ─── 2. Burner Email ──────────────────────────────────────────────────────
function getBurnerEmail() {
  step("Getting burner email...");
  try {
    const email = execSync(`python3 ${BURNER_SCRIPT} create`, { encoding: "utf-8" }).trim();
    if (!email) throw new Error("Script returned empty email");
    ok(`Burner email: ${email}`);
    return email;
  } catch (e) {
    fail(`Failed to get burner email: ${e.message}`);
    process.exit(1);
  }
}

function getConfirmationLink() {
  // burner_email.py polls AgentMail until the Hugging Face confirmation URL is
  // visible, then returns the link for the browser session to open.
  step("Waiting for confirmation email...");
  try {
    const output = execSync(`python3 ${BURNER_SCRIPT} check`, { encoding: "utf-8" });
    const match = output.match(/https:\/\/huggingface\.co\/[^\s"'<>]+/);
    if (match) {
      ok(`Found confirmation link.`);
      return match[0];
    }
    if (output.trim().startsWith("http")) return output.trim();

    fail("No confirmation link found in output.");
    process.exit(1);
  } catch (e) {
    fail(`Failed to get confirmation link: ${e.message}`);
    process.exit(1);
  }
}

function burnInbox() {
  // Inbox cleanup is non-critical, but it keeps AgentMail from accumulating
  // dead mailboxes across retries.
  step("Burning burner email inbox...");
  try {
    execSync(`python3 ${BURNER_SCRIPT} burn`, { encoding: "utf-8" });
    ok("Inbox burned.");
  } catch (e) {
    fail(`Burn failed (non-critical): ${e.message}`);
  }
}

function isRetryableRunError(message) {
  const text = String(message || "").toLowerCase();
  return [
    "hcaptcha accessibility cookie injection failed",
    "hcaptcha cookie injection verification failed",
    "could not extract hf token",
  ].some((needle) => text.includes(needle));
}

// ─── Cookie injection ─────────────────────────────────────────────────────
function normalizeSameSite(value) {
  return ["Strict", "Lax", "None"].includes(value) ? value : "Lax";
}

function partitionKeyValue(cookie) {
  if (!cookie || !cookie.partitionKey) return "";
  if (typeof cookie.partitionKey === "string") return cookie.partitionKey;
  if (cookie.partitionKey.topLevelSite) return cookie.partitionKey.topLevelSite;
  return JSON.stringify(cookie.partitionKey);
}

function cookieKey(cookie) {
  // Chrome may round-trip partition metadata differently after addCookies().
  // Verify the stable storage identity so partition formatting differences do
  // not make an accepted cookie look missing.
  return `${cookie.name}|${cookie.domain}|${cookie.path || "/"}`;
}

function cookieDiagnosticKey(cookie) {
  const partition = partitionKeyValue(cookie);
  return partition ? `${cookieKey(cookie)}|partitionKey=${partition}` : cookieKey(cookie);
}

function formatCookie(cookie) {
  const parts = [
    `${cookie.name}@${cookie.domain}${cookie.path || "/"}`,
    `sameSite=${cookie.sameSite || "?"}`,
    `secure=${Boolean(cookie.secure)}`,
    `httpOnly=${Boolean(cookie.httpOnly)}`,
  ];
  const partition = partitionKeyValue(cookie);
  if (partition) parts.push(`partitionKey=${partition}`);
  return parts.join(" ");
}

function normalizeCookieValue(value) {
  if (!value) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function describeDocumentCookie(cookieText) {
  // document.cookie exposes readable cookie values, which are credentials in
  // practice. Keep diagnostics useful by logging only the cookie names present
  // inside the frame, not the actual secret values.
  const normalized = normalizeCookieValue(cookieText);
  if (!normalized) return "[empty]";
  if (normalized.startsWith("[[unavailable:")) return normalized;

  const names = normalized
    .split(";")
    .map((part) => part.trim().split("=")[0])
    .filter(Boolean);

  return names.length ? names.join(", ") : "[empty]";
}

async function collectFrameCookieEvidence(frame) {
  const url = frame.url();
  let cookieText = "";
  let bodyText = "";

  try {
    cookieText = await frame.evaluate(() => document.cookie);
  } catch (err) {
    cookieText = `[[unavailable: ${err.message}]]`;
  }

  try {
    bodyText = await frame.evaluate(() => document.body?.innerText || document.documentElement?.innerText || "");
  } catch (err) {
    bodyText = `[[unavailable: ${err.message}]]`;
  }

  return {
    url,
    cookieText: describeDocumentCookie(cookieText),
    bodyText: normalizeCookieValue(bodyText),
  };
}

async function logHcaptchaDiagnostics(context, page, label) {
  warn(`hCaptcha diagnostics (${label})`);
  warn(`Top-level URL: ${page.url()}`);

  const cookies = await context.cookies(HCAPTCHA_COOKIE_URLS);
  if (!cookies.length) {
    warn("No hCaptcha-domain cookies visible in the context");
  } else {
    for (const cookie of cookies) warn(`Cookie: ${formatCookie(cookie)}`);
  }

  const frames = page.frames().filter((frame) => HCAPTCHA_FRAME_RE.test(frame.url()));
  if (!frames.length) {
    warn("No hCaptcha iframe/frame URLs found on the page");
    return { challengeVisible: false, iframeCookieVisible: false };
  }

  let iframeCookieVisible = false;
  let challengeVisible = false;

  for (const frame of frames) {
    const evidence = await collectFrameCookieEvidence(frame);
    if (/hc_(?:accessibility|at)/i.test(evidence.cookieText)) iframeCookieVisible = true;
    if (CAPTCHA_BODY_RE.test(evidence.bodyText) || CAPTCHA_BODY_RE.test(evidence.url)) challengeVisible = true;

    warn(`Frame: ${evidence.url}`);
    warn(`  document.cookie: ${evidence.cookieText || "[empty]"}`);
    if (evidence.bodyText) warn(`  body text: ${evidence.bodyText.slice(0, 300)}`);
  }

  return { challengeVisible, iframeCookieVisible };
}

function toPlaywrightCookie(cookie) {
  const out = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    sameSite: normalizeSameSite(cookie.sameSite),
  };

  if (cookie.expires && cookie.expires > 0) out.expires = cookie.expires;

  if (cookie.partitionKey) {
    if (typeof cookie.partitionKey === "string") {
      out.partitionKey = cookie.partitionKey;
    } else if (cookie.partitionKey.topLevelSite) {
      out.partitionKey = cookie.partitionKey.topLevelSite;
      if (typeof cookie.partitionKey.hasCrossSiteAncestor === "boolean") {
        out._crHasCrossSiteAncestor = cookie.partitionKey.hasCrossSiteAncestor;
      }
    }
  }

  return out;
}

async function openCookiePrimingTabs(context) {
  const tabs = [];

  for (const url of HCAPTCHA_COOKIE_URLS) {
    const tab = await context.newPage();
    tabs.push(tab);

    try {
      await tab.goto(url, { waitUntil: "domcontentloaded", timeout: COOKIE_PRIME_TIMEOUT });
      await tab.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    } catch (err) {
      dbg(`Cookie priming tab failed for ${url}: ${err.message}`);
    }
  }

  return tabs;
}

async function reloadCookieTabs(tabs) {
  for (const tab of tabs || []) {
    if (tab.isClosed()) continue;
    try {
      await tab.reload({ waitUntil: "domcontentloaded", timeout: COOKIE_PRIME_TIMEOUT });
      await tab.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    } catch (err) {
      dbg(`Cookie priming tab reload failed for ${tab.url()}: ${err.message}`);
    }
  }
}

async function closePages(pages) {
  for (const page of pages || []) {
    try { if (!page.isClosed()) await page.close(); } catch {}
  }
}

async function injectHcCookiesWithPriming(context, cookies, label = "browser profile") {
  // Keep cookie injection on one clean path:
  // 1. open real hCaptcha-domain tabs so Chrome has live site storage buckets,
  // 2. add the saved cookie jar to the browser context/profile,
  // 3. reload those hCaptcha tabs so the renderer process sees the new jar,
  // 4. verify through context.cookies(), then close the temporary tabs.
  let tabs = [];
  try {
    step(`Opening hCaptcha cookie priming tabs (${label})...`);
    tabs = await openCookiePrimingTabs(context);

    step(`Injecting hc_cookies into ${label}...`);
    await injectHcCookies(context, cookies, tabs);
  } finally {
    await closePages(tabs);
  }
}

async function verifyHcCookiesWithPriming(context, cookies, label = "browser profile") {
  let tabs = [];
  try {
    step(`Opening hCaptcha cookie priming tabs for verification (${label})...`);
    tabs = await openCookiePrimingTabs(context);

    step(`Verifying hc_cookies in ${label}...`);
    await verifyHcCookies(context, cookies, tabs);
  } finally {
    await closePages(tabs);
  }
}

async function injectHcCookies(context, cookies, tabs = []) {
  // Inject the full hCaptcha cookie jar, then verify every cookie we saved is
  // visible in the Playwright context. This keeps the browser session aligned
  // with the exact cookie state produced by hc_cookie_refresh.js.
  const normalized = cookies.map(toPlaywrightCookie);
  await context.addCookies(normalized);
  await verifyHcCookies(context, normalized, tabs);
}

async function verifyHcCookies(context, cookies, tabs = []) {
  // Read-only verification: use this after navigation so the signup flow does
  // not repeatedly rewrite the same cookie jar mid-session.
  const normalized = cookies.map(toPlaywrightCookie);
  await reloadCookieTabs(tabs);

  let actualCookies = await context.cookies(HCAPTCHA_COOKIE_URLS);
  let actual = new Set(actualCookies.map(cookieKey));
  let missing = normalized.filter((cookie) => !actual.has(cookieKey(cookie)));

  if (missing.length > 0) {
    await sleep(1500);
    await reloadCookieTabs(tabs);
    actualCookies = await context.cookies(HCAPTCHA_COOKIE_URLS);
    actual = new Set(actualCookies.map(cookieKey));
    missing = normalized.filter((cookie) => !actual.has(cookieKey(cookie)));

    if (missing.length > 0) {
      warn(`Missing hCaptcha cookie(s) after verification: ${missing.map(cookieDiagnosticKey).join(", ")}`);
      warn(`Visible hCaptcha cookie(s): ${actualCookies.map(cookieDiagnosticKey).join(", ") || "[none]"}`);
      throw new Error("hCaptcha cookie injection verification failed");
    }
  }

  ok(`Cookies verified in session (${actualCookies.length} hCaptcha-domain cookies visible).`);
}

// ─── Profile utils ─────────────────────────────────────────────────────────
function cleanupProfile(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ─── Launch Chrome (patchright persistent context) ─────────────────────────
// Patchright launches real Google Chrome (channel:"chrome") over its own
// protocol pipe — NOT a manual spawn + connectOverCDP — so the Runtime.enable
// / Console.enable CDP leaks that anti-bot systems fingerprint are patched at
// the driver layer. We get back a BrowserContext directly; no separate `browser`
// object, no CDP port to poll, no child process to SIGTERM.
async function launchChrome(profileDir) {
  // DISPLAY must reach the Chrome process; patchright inherits process.env, so
  // set it before launch rather than passing it through (there is no env: hook
  // on launchPersistentContext).
  process.env.DISPLAY = X_DISPLAY;

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: false,
    viewport: null, // use the real TigerVNC display geometry, don't fake a desktop

    // Fingerprint flags, all verified against THIS box (Ubuntu 24.04 / Chrome
    // 146 / no GPU passthrough / TigerVNC :1). Goal: every navigator property
    // agrees, so the profile reads as a coherent real-human Linux user — not a
    // Windows-impersonating bot with Linux fingerprints leaking underneath.
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      // WebGL: without these the TigerVNC display has no GLX and Chrome returns
      // a NULL WebGL context — a louder bot signal than any renderer string.
      // --enable-unsafe-swiftshader gives a working context backed by Mesa's
      // llvmpipe, which is exactly what a real GPU-less Linux user shows (NOT the
      // SwiftShader "0x0000C0DE" headless device string).
      "--ignore-gpu-blocklist",
      "--enable-unsafe-swiftshader",
      // --accept-lang is what actually sets navigator.language; --lang alone is
      // silently ignored by Chrome and the profile locale wins.
      "--lang=en-GB",
      "--accept-lang=en-GB,en",
    ],

    // Do NOT set userAgent / locale / timezoneId / extraHTTPHeaders here.
    // Patchright's own guidance: overriding these creates detectable mismatches
    // against the real binary's client hints and the host tz. The genuine
    // Chrome 146 UA + Europe/London host tz + en-GB accept-lang already agree.
  });

  return context;
}

// ─── Main Flow ────────────────────────────────────────────────────────────
async function runOnce(attempt = 1, maxAttempts = 2) {
  // One run means one full signup attempt. If hCaptcha blocks the flow, the
  // script refreshes cookies once and retries before giving up.
  const cookies  = await ensureCookies();
  const email    = getBurnerEmail();
  const password = generatePassword();
  const username = generateUsername();
  const fullname = generateFullName();

  const profileDir  = `/tmp/chrome-hf-keys-${process.pid}`;
  let context       = null; // patchright persistent context — also IS the browser
  let page          = null;

  try {
    step("Starting Chrome...");
    context = await launchChrome(profileDir);
    ok("Chrome ready");

    await injectHcCookiesWithPriming(context, cookies, "fresh burner profile");

    page = await context.newPage();

    // ── 3. Register on HF ──────────────────────────────────────────────────
    step("Navigating to Hugging Face join page...");
    await page.goto(HF_SIGNUP_URL, { waitUntil: "networkidle" });

    step("Filling email...");
    await page.locator('input[name="email"][type="email"]').type(email, { delay: 100 });
    await humanDelay();

    step("Filling password...");
    await page.locator('input[name="password"][type="password"]').fill(password);
    await humanDelay();

    step("Clicking Next...");
    await page.locator('button[type="submit"]').filter({ hasText: "Next" }).click();
    await page.waitForLoadState("networkidle");
    await humanDelay(1000, 2000);

    let usernameInput = page.locator('input[name="username"]');
    if (!(await usernameInput.isVisible({ timeout: 5000 }).catch(() => false))) {
      const emailInput = page.locator('input[name="email"][type="email"]');
      const passwordInput = page.locator('input[name="password"][type="password"]');

      if (await emailInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        warn("Username field did not appear; email field is still visible — retrying email/password step once.");
        await emailInput.click();
        await emailInput.fill("");
        await humanDelay(300, 600);
        await emailInput.type(email, { delay: 100 });
        await humanDelay();

        if (await passwordInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          await passwordInput.click();
          await passwordInput.fill("");
          await humanDelay(300, 600);
          await passwordInput.fill(password);
          await humanDelay();
        }

        await page.locator('button[type="submit"]').filter({ hasText: "Next" }).click();
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        await humanDelay(1000, 2000);
      }
    }

    step("Filling username...");
    usernameInput = page.locator('input[name="username"]');
    await usernameInput.fill(username);
    await humanDelay();

    step("Filling full name...");
    await page.locator('input[name="fullname"]').fill(fullname);
    await humanDelay();

    step("Verifying cookies in session...");
    await verifyHcCookiesWithPriming(context, cookies, "active HF session");
    await page.bringToFront().catch(() => {});

    step("Checking terms checkbox...");
    const checkbox = page.locator('input[type="checkbox"]').first();
    if (!(await checkbox.isChecked())) {
      await checkbox.check();
    }
    await humanDelay();

    step("Clicking Create Account...");
    const createBtn = page.locator('button[type="submit"]').filter({ hasText: "Create Account" });
    const createBtnCount = await createBtn.count();
    if (createBtnCount === 0) throw new Error("Create Account button not found");
    await createBtn.first().scrollIntoViewIfNeeded();
    await humanDelay(300, 600);
    await createBtn.first().click();
    step("Create Account clicked — waiting for response...");
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await humanDelay(2000, 3000);

    const hcaptchaDiag = await logHcaptchaDiagnostics(context, page, "after Create Account");
    if (hcaptchaDiag.challengeVisible) {
      warn("hCaptcha challenge/puzzle is visible after account submission.");
      if (hcaptchaDiag.iframeCookieVisible) {
        warn("The hCaptcha iframe can read accessibility cookies, so this is not a plain injection failure.");
      } else {
        warn("The hCaptcha iframe cannot read the accessibility cookie from this context.");
      }

      await context.close().catch(() => {});
      cleanupProfile(profileDir);
      burnInbox();
      return "CAPTCHA_BLOCKED";
    }

    // ── 4. Confirm Email (with captcha fallback) ─────────────────────────────
    // If no confirmation email arrives, the flow assumes hCaptcha or similar
    // friction blocked the signup and forces a cookie refresh retry.
    step(`Polling for confirmation email (${CONFIRM_EMAIL_TIMEOUT}s)...`);
    let confirmLink = null;
    try {
      confirmLink = execSync(`timeout ${CONFIRM_EMAIL_TIMEOUT} python3 ${BURNER_SCRIPT} check`, { encoding: "utf-8" }).trim();
      const match = confirmLink.match(/https:\/\/huggingface\.co\/[^\s"'<>]+/);
      confirmLink = match ? match[0] : (confirmLink.startsWith("http") ? confirmLink : null);
    } catch {
      confirmLink = null;
    }

    if (!confirmLink) {
      warn(`No confirmation email in ${CONFIRM_EMAIL_TIMEOUT}s — likely hCaptcha.`);
      await context.close();
      cleanupProfile(profileDir);
      burnInbox();

      if (attempt >= maxAttempts) {
        fail("No retry attempts left; not refreshing cookies again.");
        return "FAILED";
      }

      warn("Refreshing cookies before retry...");
      step("Running hc_cookie_refresh.js...");
      try {
        execSync(`node ${REFRESH_SCRIPT}`, { stdio: "inherit" });
        ok("Cookies refreshed. Retrying HF flow...");
      } catch (e) {
        fail("Cookie refresh failed.");
        process.exit(1);
      }

      return "RETRY";
    }

    ok("Found confirmation link.");
    step("Navigating to confirmation link...");
    try {
      await page.goto(confirmLink, { waitUntil: "networkidle" });
} catch (err) {
  if (!err.message.includes("interrupted by another navigation")) throw err;
  // HF redirects mid-load — expected, let it settle
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
}
await page.waitForURL(/huggingface\.co\/(users|settings|email_confirmation)/, { timeout: 15000 }).catch(() => {});
await humanDelay(2000, 4000);
ok("Email confirmed.");

    // ── 5. Create Token ────────────────────────────────────────────────────
   step("Navigating to token creation page...");
   await page.goto("https://huggingface.co/settings/tokens/new?tokenType=write", { waitUntil: "domcontentloaded" });
   await page.locator('input[name="displayName"]').waitFor({ state: "visible", timeout: 15000 });
   await humanDelay(500, 1000);

   step("Filling token name...");
   await page.locator('input[name="displayName"]').fill(`token_${Date.now()}`);
   await humanDelay();

      step("Clicking Create token...");
    for (const sel of [
      'button[type="submit"].btn-lg',
      'button.btn-lg[type="submit"]',
      'button:has-text("Create token")',
      'button[type="submit"]',
    ]) {
      try {
        const el = page.locator(sel).first();
        if (await el.count() > 0 && await el.isVisible()) {
          await el.click();
          step("Create token submitted");
          break;
        }
      } catch {}
    }

    // Let the page fully settle after submit
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await sleep(2000);

    // ── 6. Extract Key ─────────────────────────────────────────────────────
    step("Extracting HF token...");
    let hfKey = null;

    for (let attempt = 0; attempt < 20 && !hfKey; attempt++) {
      await sleep(1000);

      // Method 1 — readonly / text inputs (most reliable)
      try {
        const inputs = await page.locator('input[readonly], input[type="text"]').all();
        for (const inp of inputs) {
          const val = await inp.inputValue().catch(() => "");
          if (val.startsWith("hf_") && val.length > 20) {
            hfKey = val;
            break;
          }
        }
      } catch {}

      if (hfKey) break;

      // Method 2 — regex scan page HTML, skip false positives
      try {
        const content = await page.content();
        for (const m of content.matchAll(/hf_[a-zA-Z0-9_-]{20,}/g)) {
          const candidate = m[0];
          const pos = m.index;
          const surrounding = content.slice(Math.max(0, pos - 20), pos + candidate.length + 20);
          if (['src=', 'href=', 'url(', '.js"', '.css"'].some(x => surrounding.includes(x))) continue;
          hfKey = candidate;
          break;
        }
      } catch {}
    }

    if (!hfKey) {
      throw new Error("Could not extract HF token.");
    }

    ok(`Token extracted: ${hfKey.substring(0, 10)}...`);

    // ── 7. Save Key ────────────────────────────────────────────────────────
    fs.appendFileSync(KEYS_PATH, `${hfKey}\n`);
    ok(`Saved to ${KEYS_PATH}`);

    // ── 8. Burn the inbox ──────────────────────────────────────────────────
    burnInbox();

  } catch (err) {
    // Any browser failure should leave a screenshot behind; debugging these
    // flows without visual evidence is just self-harm with extra steps.
    fail(`Error: ${err.message}`);
    if (page) {
      try { await page.screenshot({ path: "/root/fail_hf_flow.png", fullPage: true }); } catch {}
    }
    burnInbox();
    if (attempt < maxAttempts && isRetryableRunError(err.message)) {
      warn("Transient failure detected; retrying the HF flow.");
      return "RETRY";
    }
    process.exit(1);
  } finally {
    if (context) { try { await context.close(); } catch {} }
    cleanupProfile(profileDir);
  }
}

async function main() {
  // Two attempts is enough to cover the common "cookie refresh fixed it" path
  // without turning this into an unbounded retry loop.
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      step(`Retrying Hugging Face flow (${attempt}/${maxAttempts})...`);
    }

    const result = await runOnce(attempt, maxAttempts);
    if (result === "CAPTCHA_BLOCKED") {
      fail("HF signup is captcha-blocked; stopping cleanly.");
      process.exit(CAPTCHA_BLOCK_EXIT_CODE);
    }
    if (result !== "RETRY") return;
  }

  fail("HF flow still blocked after cookie refresh retry.");
  process.exit(1);
}

main();
