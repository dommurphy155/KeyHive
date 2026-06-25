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
const { execFileSync } = require("child_process");
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
const FAILURE_SCREENSHOT = path.join(ROOT_DIR, "logs", "fail_hf_flow.png");
const REFRESH_SCRIPT = path.join(ROOT_DIR, "scripts", "hc_cookie_refresh.js");
const BURNER_SCRIPT  = path.join(ROOT_DIR, "scripts", "burner_email.py");
const PYTHON_BIN = process.env.KEYHIVE_PYTHON_BIN || (fs.existsSync(path.join(ROOT_DIR, ".venv", "bin", "python")) ? path.join(ROOT_DIR, ".venv", "bin", "python") : "python3");
const HCAPTCHA_LOGIN_URL = "https://dashboard.hcaptcha.com/login?type=accessibility";
const HCAPTCHA_COOKIE_URLS = [
  "https://hcaptcha.com",
  "https://www.hcaptcha.com",
  "https://dashboard.hcaptcha.com",
  "https://accounts.hcaptcha.com",
  "https://api.hcaptcha.com",
];
const CAPTCHA_BLOCK_EXIT_CODE = 2;
const HF_SIGNUP_URL = "https://huggingface.co/join";

// Chrome runs with a throwaway profile dir so the signup flow can be observed
// and cleaned up without disturbing the browser-strength profiles. Patchright
// talks to Chrome over a protocol pipe (not a network CDP port), so there's no
// remote-debugging-port to manage here — launchPersistentContext handles it.
const X_DISPLAY = ":1";
const CONFIRM_EMAIL_TIMEOUT = 7;
const CREATE_ACCOUNT_SETTLE_TIMEOUT = 7000;
const COOKIE_PRIME_TIMEOUT = 12000;
const COOKIE_PRIME_TAB_COUNT = 3;

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
function readCookieFile() {
  const data = JSON.parse(fs.readFileSync(COOKIE_PATH, "utf-8"));
  return Array.isArray(data) ? data : [data];
}

function isCookieExpired(cookie, leewaySeconds = 300) {
  return Boolean(cookie.expires && cookie.expires > 0 && cookie.expires <= (Date.now() / 1000) + leewaySeconds);
}

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
      let cookies = [];
      try {
        cookies = readCookieFile();
      } catch (err) {
        warn(`Cookie file is unreadable: ${err.message}`);
        needsRefresh = true;
      }

      const hcAccessibility = pickHcAccessibilityCookie(cookies);
      if (!needsRefresh && !hcAccessibility) {
        warn("hc_cookie.json has no hc_accessibility cookie.");
        needsRefresh = true;
      } else if (!needsRefresh && isCookieExpired(hcAccessibility)) {
        warn("hc_accessibility cookie is expired or about to expire.");
        needsRefresh = true;
      } else if (!needsRefresh) {
        ok(`Cookie is fresh (${hours.toFixed(1)}h old, hc_accessibility valid).`);
      }
    }
  }

  if (needsRefresh) {
    // The refresh flow is expensive, so only rerun it when the cookie file is
    // missing or stale enough to be suspicious.
    step("Running hc_cookie_refresh.js...");
    try {
      execFileSync("node", [REFRESH_SCRIPT], { stdio: "inherit" });
      ok("Cookie refreshed.");
    } catch (e) {
      fail("Failed to refresh cookie.");
      process.exit(1);
    }
  }

  const cookies = readCookieFile();
  const hcAccessibility = pickHcAccessibilityCookie(cookies);
  if (!hcAccessibility) {
    fail("hc_cookie.json still has no hc_accessibility cookie after refresh.");
    process.exit(1);
  }
  if (isCookieExpired(hcAccessibility, 0)) {
    fail("hc_cookie.json still has an expired hc_accessibility cookie after refresh.");
    process.exit(1);
  }

  return cookies;
}

// ─── 2. Burner Email ──────────────────────────────────────────────────────
function getBurnerEmail() {
  step("Getting burner email...");
  try {
    const email = execFileSync(PYTHON_BIN, [BURNER_SCRIPT, "create"], { encoding: "utf-8" }).trim();
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
    const output = execFileSync(PYTHON_BIN, [BURNER_SCRIPT, "check"], { encoding: "utf-8" });
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
    execFileSync(PYTHON_BIN, [BURNER_SCRIPT, "burn"], { encoding: "utf-8" });
    ok("Inbox burned.");
  } catch (e) {
    fail(`Burn failed (non-critical): ${e.message}`);
  }
}

function refreshCookiesOrExit() {
  step("Running hc_cookie_refresh.js...");
  try {
    execFileSync("node", [REFRESH_SCRIPT], { stdio: "inherit" });
    ok("Cookies refreshed. Retrying HF flow...");
  } catch (e) {
    fail("Cookie refresh failed.");
    process.exit(1);
  }
}

function isRetryableRunError(message) {
  const text = String(message || "").toLowerCase();
  return [
    "hcaptcha accessibility cookie injection failed",
    "hcaptcha cookie injection verification failed",
    "hc_accessibility cookie missing before submit",
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

function cookieName(cookie) {
  return String(cookie?.name || "").toLowerCase();
}

function pickHcAccessibilityCookie(cookies) {
  return cookies.find((cookie) => cookieName(cookie) === "hc_accessibility") || null;
}

function hasHcAccessibilityCookie(cookies) {
  return Boolean(pickHcAccessibilityCookie(cookies));
}

async function waitForUsernameForm(page, timeout = 30000) {
  const usernameInput = page.locator('input[name="username"]');
  try {
    await usernameInput.waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

function cookieDiagnosticKey(cookie) {
  const partition = partitionKeyValue(cookie);
  return partition ? `${cookieKey(cookie)}|partitionKey=${partition}` : cookieKey(cookie);
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

  for (let i = 0; i < COOKIE_PRIME_TAB_COUNT; i++) {
    const tab = await context.newPage();
    tabs.push(tab);

    try {
      await tab.goto(HCAPTCHA_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: COOKIE_PRIME_TIMEOUT });
      await tab.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    } catch (err) {
      dbg(`Cookie priming tab failed for ${HCAPTCHA_LOGIN_URL}: ${err.message}`);
    }
  }

  return tabs;
}

async function closePages(pages) {
  for (const page of pages || []) {
    try { if (!page.isClosed()) await page.close(); } catch {}
  }
}

async function injectHcAccessibilityWithPriming(context, cookies, label = "browser profile") {
  const hcAccessibility = pickHcAccessibilityCookie(cookies);
  if (!hcAccessibility) {
    throw new Error("hc_accessibility cookie missing from hc_cookie.json");
  }

  let tabs = [];
  try {
    step(`Opening ${COOKIE_PRIME_TAB_COUNT} hCaptcha login priming tabs (${label})...`);
    tabs = await openCookiePrimingTabs(context);

    step(`Injecting hc_accessibility into ${label}...`);
    await context.addCookies([toPlaywrightCookie(hcAccessibility)]);
    ok("hc_accessibility injected");
  } finally {
    await closePages(tabs);
  }
}

async function ensureHcCookiesBeforeSubmit(context, cookies) {
  const hcAccessibility = pickHcAccessibilityCookie(cookies);
  if (!hcAccessibility) {
    throw new Error("hc_accessibility cookie missing from hc_cookie.json");
  }

  let actualCookies = await context.cookies(HCAPTCHA_COOKIE_URLS);
  if (hasHcAccessibilityCookie(actualCookies)) {
    ok("hc_accessibility present before submit");
    return true;
  }

  warn("hc_accessibility missing before submit; reinjecting once.");
  await context.addCookies([toPlaywrightCookie(hcAccessibility)]);
  await sleep(1000);

  actualCookies = await context.cookies(HCAPTCHA_COOKIE_URLS);
  if (hasHcAccessibilityCookie(actualCookies)) {
    ok("hc_accessibility present after reinjection");
    return true;
  }

  warn(`Visible hCaptcha cookie(s): ${actualCookies.map(cookieDiagnosticKey).join(", ") || "[none]"}`);
  throw new Error("hc_accessibility cookie missing before submit after reinjection");
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
    cleanupProfile(profileDir);
    context = await launchChrome(profileDir);
    ok("Chrome ready");

    await injectHcAccessibilityWithPriming(context, cookies, "fresh burner profile");

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

    step("Waiting for username form...");
    let usernameInput = page.locator('input[name="username"]');
    if (!(await waitForUsernameForm(page, 30000))) {
      const emailInput = page.locator('input[name="email"][type="email"]');
      const passwordInput = page.locator('input[name="password"][type="password"]');

      if (await emailInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        warn("Username form did not appear; email form is still visible — retrying email/password step once.");
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
      }
    }

    step("Filling username...");
    usernameInput = page.locator('input[name="username"]');
    await usernameInput.waitFor({ state: "visible", timeout: 30000 });
    await usernameInput.fill(username);
    await humanDelay();

    step("Filling full name...");
    await page.locator('input[name="fullname"]').fill(fullname);
    await humanDelay();

    step("Checking hCaptcha cookies before submit...");
    await ensureHcCookiesBeforeSubmit(context, cookies);
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
    const createBtnFirst = createBtn.first();
    await createBtnFirst.waitFor({ state: "visible", timeout: 10000 });
    await createBtnFirst.scrollIntoViewIfNeeded();
    if (!(await createBtnFirst.isEnabled())) {
      throw new Error("Create Account button is disabled");
    }
    await humanDelay(300, 600);
    const beforeSubmitUrl = page.url();
    await createBtnFirst.click();
    step(`Create Account clicked — waiting ${CONFIRM_EMAIL_TIMEOUT}s for email...`);
    await Promise.race([
      page.waitForURL((url) => url.href !== beforeSubmitUrl, { timeout: CREATE_ACCOUNT_SETTLE_TIMEOUT }).catch(() => {}),
      sleep(CREATE_ACCOUNT_SETTLE_TIMEOUT),
    ]);

    // ── 4. Confirm Email (with captcha fallback) ─────────────────────────────
    // If no confirmation email arrives, the flow assumes hCaptcha or similar
    // friction blocked the signup and forces a cookie refresh retry.
    let confirmLink = null;
    try {
      confirmLink = execFileSync("timeout", [String(CONFIRM_EMAIL_TIMEOUT), PYTHON_BIN, BURNER_SCRIPT, "check"], { encoding: "utf-8" }).trim();
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
      refreshCookiesOrExit();
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
      try {
        fs.mkdirSync(path.dirname(FAILURE_SCREENSHOT), { recursive: true });
        await page.screenshot({ path: FAILURE_SCREENSHOT, fullPage: true });
      } catch {}
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
