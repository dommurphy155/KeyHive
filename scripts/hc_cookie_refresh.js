// Refresh the hCaptcha accessibility cookie jar from the ready browser
// profiles produced by browser_strength.js. The saved cookie file is the
// only output hf_keys.js cares about.
"use strict";

const { chromium } = require("playwright");
const { spawn, spawnSync, execSync } = require("child_process");
const fs   = require("fs");
const path = require("path");
const ROOT_DIR = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT_DIR, ".env") });

// ─── Config ────────────────────────────────────────────────────────────────
// These paths and ports are shared with the browser-strength flow so this
// script can reuse the exact same visible Chrome session.
const LOGIN_URL    = "https://dashboard.hcaptcha.com/login?type=accessibility";
const CDP_PORT     = 9333;
const CDP_HOST     = "127.0.0.1";
const X_DISPLAY    = ":1";
const CHROME_LOG   = path.join(ROOT_DIR, "logs", "chrome-9333.log");
const COOKIE_OUT   = path.join(ROOT_DIR, "data", "hc_cookie.json");
const PROFILE_ROOT = path.join(ROOT_DIR, "profiles", "google");
const STRENGTH_DIR = path.join(ROOT_DIR, "data", "browser_strength");
const ACCOUNT_STATUS_PATH = path.join(STRENGTH_DIR, "accounts.json");
const BROWSER_STRENGTH_SCRIPT = path.join(ROOT_DIR, "scripts", "browser_strength.js");

const POLL_TIMEOUT  = 20000;
const POLL_INTERVAL = 300;

const QUOTA_PHRASES = [
  "used your allowed amount",
  "used up all your cookies",
  "cookie limit",
  "try again tomorrow",
];

// ─── Logging ──────────────────────────────────────────────────────────────
const ts   = () => new Date().toISOString().slice(11, 19);
const step = (msg) => console.log(`[${ts()}] › ${msg}`);
const ok   = (msg) => console.log(`[${ts()}] ✓ ${msg}`);
const warn = (msg) => console.log(`[${ts()}] ⚠ ${msg}`);
const fail = (msg) => console.error(`[${ts()}] ✗ ${msg}`);
const dbg  = (msg) => { if (process.env.DEBUG) console.log(`[${ts()}]   ${msg}`); };

// ─── Helpers ──────────────────────────────────────────────────────────────
const sleep      = (ms)  => new Promise((r) => setTimeout(r, ms));
const humanDelay = (min = 500, max = 1200) => sleep(min + Math.random() * (max - min));

// Load Gmail credentials from the shared .env file. The refresh script uses the
// same account list that browser_strength.js validates and checkpoints.
function loadAccounts() {
  const raw = process.env.GMAIL_ACCOUNTS;
  if (!raw) {
    console.error("✗ Missing GMAIL_ACCOUNTS in .env");
    console.error('  Expected: GMAIL_ACCOUNTS=[{"email":"x@gmail.com","password":"y"}]');
    process.exit(1);
  }
  try {
    const accounts = JSON.parse(raw);
    if (!Array.isArray(accounts) || accounts.length === 0) throw new Error("empty array");
    for (const a of accounts) {
      if (!a.email || !a.password) throw new Error(`account missing email/password: ${JSON.stringify(a)}`);
    }
    return accounts;
  } catch (e) {
    console.error(`✗ GMAIL_ACCOUNTS parse error: ${e.message}`);
    process.exit(1);
  }
}

// Save the cookie jar atomically so hf_keys.js never reads a half-written file.
// This is intentionally strict: without an accessibility cookie, the write is
// rejected because the refresh did not actually succeed.
function saveCookies(cookies) {
  fs.mkdirSync(path.dirname(COOKIE_OUT), { recursive: true });
  const finalCookies = normalizeHcCookies(cookies);
  if (!hasAccessibilityCookie(finalCookies)) {
    throw new Error("Refusing to save hCaptcha cookies without hc_accessibility/hc_at");
  }

  const tmp = `${COOKIE_OUT}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(finalCookies, null, 2) + "\n");
  fs.renameSync(tmp, COOKIE_OUT);
}

function readAccountStatus() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNT_STATUS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function statusPath(value) {
  if (!value || typeof value !== "string") return null;
  return path.isAbsolute(value) ? value : path.resolve(ROOT_DIR, value);
}

function readyProfileDir(account) {
  // Only profiles that browser_strength.js marked as fully ready are eligible.
  const status = readAccountStatus()[account.email];
  if (!status || typeof status.profileDir !== "string") return null;

  const profileDir = statusPath(status.profileDir);
  const storageStatePath = statusPath(status.storageStatePath);
  const ready = status.googleLoggedIn === true &&
    status.gmailChecked === true &&
    status.hcaptchaReachable === true &&
    status.setCookieVisible === true &&
    Boolean(profileDir) &&
    Boolean(storageStatePath) &&
    fs.existsSync(profileDir) &&
    fs.statSync(profileDir).isDirectory() &&
    fs.existsSync(storageStatePath) &&
    fs.statSync(storageStatePath).isFile();

  return ready ? profileDir : null;
}

function isProfileReady(account) {
  return Boolean(readyProfileDir(account));
}

function ensureReadyProfiles(accounts) {
  // If the profile state file says an account is stale or incomplete, rerun the
  // browser-strength prep step before trying to refresh cookies.
  fs.mkdirSync(PROFILE_ROOT, { recursive: true });
  fs.mkdirSync(STRENGTH_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(CHROME_LOG), { recursive: true });

  const missing = accounts.filter((account) => !isProfileReady(account));
  if (missing.length === 0) {
    ok("All browser profiles are ready");
    return;
  }

  warn(`Missing/not-ready browser profile(s): ${missing.map((a) => a.email).join(", ")}`);

  for (const account of missing) {
    step(`Running browser_strength.js for ${account.email}`);
    const result = spawnSync(process.execPath, [BROWSER_STRENGTH_SCRIPT, "--email", account.email], {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: "inherit",
    });

    if (result.error) {
      warn(`browser_strength.js could not run for ${account.email}: ${result.error.message}`);
      continue;
    }

    if (result.status !== 0) {
      warn(`browser_strength.js exited with ${result.status} for ${account.email}; continuing with any profiles that are ready`);
    }
  }
}

// ─── Port + profile utils ──────────────────────────────────────────────────
function killPort(port) {
  try { execSync(`fuser -k ${port}/tcp 2>/dev/null || true`); } catch {}
}

async function killProfileChrome(profileDir) {
  spawnSync("pkill", ["-TERM", "-f", `--user-data-dir=${profileDir}`], { stdio: "ignore" });
  await sleep(1200);
  spawnSync("pkill", ["-KILL", "-f", `--user-data-dir=${profileDir}`], { stdio: "ignore" });
}

// ─── Spawn Chrome ──────────────────────────────────────────────────────────
function launchChrome(profileDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(profileDir, { recursive: true });
    fs.mkdirSync(path.dirname(CHROME_LOG), { recursive: true });

    const child = spawn(
      "google-chrome-stable",
      [
        `--remote-debugging-port=${CDP_PORT}`,
        `--remote-debugging-address=${CDP_HOST}`,
        `--user-data-dir=${profileDir}`,
        "--profile-directory=Default",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        // Keep the launch shape consistent with the prep script so the browser
        // fingerprint stays stable across the two phases of the flow.
        "--disable-blink-features=AutomationControlled",
        "--password-store=basic",
        "--use-mock-keychain",
        "--use-gl=swiftshader",
        "--use-angle=swiftshader-webgl",
        "--enable-webgl",
        "--ignore-gpu-blocklist",
        "--enable-gpu-rasterization",
        "--window-size=1920,1080",
        "--start-maximized",
        "--lang=en-GB",
        "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      ],
      {
        env:      { ...process.env, DISPLAY: X_DISPLAY },
        detached: false,
        stdio:    ["ignore", "pipe", "pipe"],
      }
    );

    const logStream = fs.createWriteStream(CHROME_LOG, { flags: "a" });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);

    child.on("error", (err) => reject(new Error(`Chrome spawn failed: ${err.message}`)));
    child.on("exit",  (code, sig) => dbg(`Chrome exited (code=${code} sig=${sig})`));

    let done = false;
    const deadline = Date.now() + 15000;

    const poll = setInterval(async () => {
      if (done) return;
      try {
        const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`);
        if (res.ok) {
          done = true;
          clearInterval(poll);
          resolve(child);
        }
      } catch {
        if (Date.now() > deadline) {
          done = true;
          clearInterval(poll);
          reject(new Error("CDP never came alive within 15s"));
        }
      }
    }, 300);
  });
}

async function killChrome(child, profileDir) {
  if (child && !child.killed) {
    try { child.kill("SIGTERM"); } catch {}
    await sleep(1500);
    if (!child.killed) {
      try { child.kill("SIGKILL"); } catch {}
    }
  }
  if (profileDir) await killProfileChrome(profileDir);
}

// ─── Poll primitives ───────────────────────────────────────────────────────
async function pollForAny(page, label, candidates, timeout = POLL_TIMEOUT) {
  // hCaptcha and Google both vary their DOM enough that the code needs a
  // fallback selector list rather than one brittle locator.
  dbg(`[${label}] polling ${candidates.length} candidate(s)...`);
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const { description, locatorFn } of candidates) {
      try {
        const loc   = locatorFn(page);
        const count = await loc.count();
        if (count === 0) continue;
        if (!(await loc.first().isVisible())) continue;
        dbg(`[${label}] hit: "${description}"`);
        return { locator: loc.first(), description };
      } catch {}
    }
    await sleep(POLL_INTERVAL);
  }

  throw new Error(`[${label}] nothing visible after ${timeout}ms`);
}

async function pollAndClick(page, label, candidates, timeout = POLL_TIMEOUT) {
  const { locator } = await pollForAny(page, label, candidates, timeout);
  await locator.scrollIntoViewIfNeeded();
  await humanDelay(300, 700);
  await locator.click();
}

async function pollAndFill(page, label, candidates, value, timeout = POLL_TIMEOUT) {
  const { locator } = await pollForAny(page, label, candidates, timeout);
  await locator.scrollIntoViewIfNeeded();
  await humanDelay(200, 500);
  await locator.click();
  await humanDelay(150, 350);
  await locator.fill(value);
}

async function visible(locator) {
  try {
    return (await locator.count()) > 0 && await locator.first().isVisible();
  } catch {
    return false;
  }
}

async function bodyText(page) {
  try { return await page.locator("body").innerText({ timeout: 3000 }); } catch { return ""; }
}

async function selectGoogleAccountIfShown(page, account) {
  // When Google offers an account chooser, reuse the existing session instead
  // of forcing another password prompt.
  try {
    const accountOption = page.getByText(account.email, { exact: true });
    if (await visible(accountOption)) {
      step(`Selecting existing Google session (${account.email})...`);
      await accountOption.first().click();
      await humanDelay(1500, 2500);
      return true;
    }
  } catch {}
  return false;
}

async function findSetCookieButton(context, timeout = POLL_TIMEOUT) {
  // The accessibility dashboard sometimes exposes "Set Cookie" on a different
  // page or in a different control shape, so scan every open page.
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const pages = context.pages()
      .filter((pg) => {
        try {
          const url = pg.url();
          return url.includes("hcaptcha.com") || url === "about:blank";
        } catch {
          return false;
        }
      })
      .sort((a, b) => {
        const aDashboard = a.url().includes("dashboard.hcaptcha.com") ? 0 : 1;
        const bDashboard = b.url().includes("dashboard.hcaptcha.com") ? 0 : 1;
        return aDashboard - bDashboard;
      });

    for (const pg of pages) {
      try {
        const loc = pg.getByRole("button", { name: /set cookie/i });
        if (await visible(loc)) return { dashPage: pg, setCookieEl: loc.first() };
      } catch {}
      try {
        const loc = pg.locator("button").filter({ hasText: /set cookie/i });
        if (await visible(loc)) return { dashPage: pg, setCookieEl: loc.first() };
      } catch {}
    }
    await sleep(POLL_INTERVAL);
  }

  return { dashPage: null, setCookieEl: null };
}

async function trySetCookieAndExtract(context, label, timeout = 500) {
  // Single attempt: find the Set Cookie control, click it, check the page for
  // a quota message, then verify the cookie jar actually gained the hCaptcha
  // accessibility token. Returns the cookies on success, null if the button is
  // not present or the click did not produce a usable cookie. The caller drives
  // the reload-and-retry loop — re-clicking a spent button never helps.
  const { dashPage, setCookieEl } = await findSetCookieButton(context, timeout);
  if (!dashPage || !setCookieEl) return null;

  step(`Set Cookie visible (${label}) — clicking now...`);

  try { checkBodyForQuota(await bodyText(dashPage)); } catch (e) {
    if (e instanceof QuotaError) throw e;
  }

  await setCookieEl.scrollIntoViewIfNeeded();
  await humanDelay(250, 600);
  await Promise.all([
    dashPage.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {}),
    setCookieEl.click(),
  ]);
  await sleep(2500);

  try { checkBodyForQuota(await bodyText(dashPage)); } catch (e) {
    if (e instanceof QuotaError) throw e;
  }

  await sleep(2500);
  const cookies = await extractHcCookies(context, dashPage);
  if (!cookies || cookies.length === 0) {
    warn("No hCaptcha cookies found after Set Cookie click — will keep trying...");
    return null;
  }

  if (!hasAccessibilityCookie(cookies)) {
    warn("Accessibility token (hc_at) not found — waiting longer...");
    await sleep(5000);
    const retry = await extractHcCookies(context, dashPage);
    if (retry && hasAccessibilityCookie(retry)) return retry;
  }

  if (!hasAccessibilityCookie(cookies)) {
    warn("No hCaptcha accessibility cookie found after Set Cookie click — will keep trying...");
    return null;
  }

  return cookies;
}

async function reloadHcaptchaAccessibility(page) {
  step("Reloading hcaptcha accessibility page...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((err) => {
    warn(`hCaptcha reload did not fully settle: ${err.message}`);
  });
  await humanDelay(1500, 2500);
}

// Drive the Set Cookie flow with the same rules for every account:
// find the button → click it → check for a quota error → check the cookie jar
// → if no cookie appeared, reload the accessibility page and try again. A
// single Set Cookie click can silently no-op (hCaptcha returns nothing), so a
// real retry requires a fresh page load, not a repeated click on a spent button.
async function runSetCookieLoop(context, page, label, totalTimeout = 30000, findTimeout = 1500) {
  const deadline = Date.now() + totalTimeout;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    const cookies = await trySetCookieAndExtract(context, `${label} #${attempt}`, findTimeout);
    if (cookies) return cookies;

    // No cookie this round — reload so the next attempt starts from a clean
    // dashboard instead of re-clicking a control that already fired.
    if (Date.now() < deadline) {
      await reloadHcaptchaAccessibility(page);
    }
  }
  return null;
}

// ─── Cookie extraction ─────────────────────────────────────────────────────
function isHcaptchaDomain(domain = "") {
  const clean = domain.replace(/^\./, "");
  return clean === "hcaptcha.com" ||
    clean === "accounts.hcaptcha.com" ||
    clean === "api.hcaptcha.com" ||
    clean.endsWith(".hcaptcha.com");
}

function isWantedHcCookie(cookie) {
  return isHcaptchaDomain(cookie.domain) &&
    (
      cookie.name === "hc_accessibility" ||
      cookie.name === "hc_at" ||
      cookie.name === "session" ||
      cookie.name === "hmt_id" ||
      cookie.name === "__cf_bm" ||
      cookie.name === "__cflb" ||
      cookie.name.startsWith("hc_")
    );
}

function partitionKeyValue(cookie) {
  if (!cookie || !cookie.partitionKey) return "";
  if (typeof cookie.partitionKey === "string") return cookie.partitionKey;
  if (cookie.partitionKey.topLevelSite) return cookie.partitionKey.topLevelSite;
  return JSON.stringify(cookie.partitionKey);
}

function cookieSortKey(cookie) {
  return `${cookie.domain}|${cookie.path || "/"}|${cookie.name}|${partitionKeyValue(cookie)}`;
}

function normalizeHcCookies(cookies) {
  const deduped = new Map();
  for (const cookie of cookies || []) {
    if (!isWantedHcCookie(cookie)) continue;
    deduped.set(cookieSortKey(cookie), cookie);
  }
  return [...deduped.values()].sort((a, b) => cookieSortKey(a).localeCompare(cookieSortKey(b)));
}

function hasAccessibilityCookie(cookies) {
  return (cookies || []).some(c =>
    isHcaptchaDomain(c.domain) &&
    (c.name === "hc_accessibility" || c.name === "hc_at")
  );
}

async function extractHcCookies(context, page) {
  // Method 1 - CDP (catches HttpOnly + gives domain/expires).
  try {
    const cdp    = await context.newCDPSession(page);
    const result = await cdp.send("Network.getAllCookies");
    await cdp.detach();
    const all = result.cookies || [];
    dbg(`CDP returned ${all.length} cookies`);
    const hcCookies = normalizeHcCookies(all);
    if (hcCookies.length > 0) return hcCookies;
  } catch (err) {
    dbg(`CDP extract failed: ${err.message}`);
  }

  // Method 2 - context.cookies() as a fallback when CDP is flaky.
  try {
    const all = await context.cookies(["https://dashboard.hcaptcha.com", "https://hcaptcha.com", "https://accounts.hcaptcha.com", "https://api.hcaptcha.com"]);
    const hcCookies = normalizeHcCookies(all);
    if (hcCookies.length > 0) return hcCookies;
  } catch (err) {
    dbg(`context.cookies() failed: ${err.message}`);
  }

  return null;
}

// ─── Quota sentinel ────────────────────────────────────────────────────────
class QuotaError extends Error {
  constructor(phrase) { super(phrase); this.name = "QuotaError"; }
}

function checkBodyForQuota(bodyText) {
  // If hCaptcha says the account quota is spent, the caller blacklists the
  // Gmail account and moves on instead of hammering the same dead session.
  for (const phrase of QUOTA_PHRASES) {
    if (bodyText.toLowerCase().includes(phrase)) throw new QuotaError(phrase);
  }
}

// ─── Single account attempt ────────────────────────────────────────────────
async function attemptAccount(account) {
  // One account attempt is one browser session: open the ready profile, reach
  // hCaptcha, click Set Cookie, and export the resulting cookies.
  const profileDir  = readyProfileDir(account);
  let chromeProcess = null;
  let browser       = null;

  try {
    if (!profileDir) {
      throw new Error(`Persistent Google profile is not ready for ${account.email}; run node ${BROWSER_STRENGTH_SCRIPT}`);
    }

    step("Starting Chrome...");
    killPort(CDP_PORT);
    await killProfileChrome(profileDir);
    chromeProcess = await launchChrome(profileDir);
    ok("Chrome ready");

    browser = await chromium.connectOverCDP(`http://${CDP_HOST}:${CDP_PORT}`);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page    = context.pages()[0]    ?? (await context.newPage());

    // ── 1. Navigate ─────────────────────────────────────────────────────────
    step("Loading hcaptcha login...");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((err) => {
      warn(`hCaptcha page load did not fully settle: ${err.message}`);
    });
    await humanDelay(1500, 2500);

    // Every account follows the same Set Cookie rules: find the button, click it,
    // check for a quota message, check the cookie jar, and reload-and-retry if no
    // cookie appeared. This is the path that works for an already-authenticated
    // profile (account 1's happy path), so we try it first and hardest.
    let cookies = await runSetCookieLoop(context, page, "after hcaptcha load", 20000, 1500);
    if (cookies) return cookies;

    // ── 2. Sign in with Google ───────────────────────────────────────────────
    // Only reach for the Google sign-in path if the dashboard still requires it
    // (i.e. Set Cookie never appeared). Re-running the loop after each Google
    // step means a profile that becomes authenticated mid-flow is caught here
    // instead of being driven blindly through the full login form.
    step("Clicking Sign in with Google...");
    await pollAndClick(page, "SignInWithGoogle", [
      { description: 'getByRole button "sign in with google"', locatorFn: (p) => p.getByRole("button", { name: /sign in with google/i }) },
      { description: 'getByRole link "sign in with google"',   locatorFn: (p) => p.getByRole("link",   { name: /sign in with google/i }) },
      { description: 'getByText "sign in with google"',        locatorFn: (p) => p.getByText(/sign in with google/i) },
      { description: '[aria-label*="google" i]',               locatorFn: (p) => p.locator('[aria-label*="google" i]') },
      { description: '[data-provider="google"]',               locatorFn: (p) => p.locator('[data-provider="google"]') },
      { description: 'a[href*="accounts.google.com"]',         locatorFn: (p) => p.locator('a[href*="accounts.google.com"]') },
    ]);
    await humanDelay(1000, 1500);
    cookies = await runSetCookieLoop(context, page, "after Google sign-in click", 8000, 1000);
    if (cookies) return cookies;

    // ── 3. Find Google auth page ─────────────────────────────────────────────
    step("Waiting for Google auth...");
    let googlePage  = null;
    const gDeadline = Date.now() + 20000;

    while (Date.now() < gDeadline) {
      for (const pg of context.pages()) {
        try {
          if (pg.url().includes("accounts.google.com")) { googlePage = pg; break; }
        } catch {}
      }
      if (googlePage) break;
      await sleep(POLL_INTERVAL);
    }

    if (!googlePage) {
      throw new Error("accounts.google.com never appeared");
    }

    ok("Google auth opened");
    try { await googlePage.waitForLoadState("domcontentloaded", { timeout: 10000 }); } catch {}
    await humanDelay(1000, 2000);
    await selectGoogleAccountIfShown(googlePage, account);
    cookies = await runSetCookieLoop(context, page, "after account selection", 8000, 1000);
    if (cookies) return cookies;

    // ── 4. Email ─────────────────────────────────────────────────────────────
    if (await visible(googlePage.locator('input[name="identifier"], #identifierId, input[type="email"]'))) {
      step(`Entering email (${account.email})...`);
      await pollAndFill(googlePage, "GoogleEmail", [
        { description: 'input[name="identifier"]', locatorFn: (p) => p.locator('input[name="identifier"]') },
        { description: "#identifierId",            locatorFn: (p) => p.locator("#identifierId") },
        { description: 'input[type="email"]',      locatorFn: (p) => p.locator('input[type="email"]') },
      ], account.email);
      await humanDelay(700, 1200);

      // ── 5. Next ──────────────────────────────────────────────────────────────
      // Google keeps moving the Next control around; this tries the common
      // button, div, and role-based variants before giving up.
      await pollAndClick(googlePage, "EmailNext", [
        { description: "#identifierNext",           locatorFn: (p) => p.locator("#identifierNext") },
        { description: 'button[jsname="LgbsSe"]',  locatorFn: (p) => p.locator('button[jsname="LgbsSe"]') },
        { description: 'getByRole button "Next"',   locatorFn: (p) => p.getByRole("button", { name: /^next$/i }) },
        { description: 'div[id="identifierNext"]',  locatorFn: (p) => p.locator('div[id="identifierNext"]') },
      ]);
      await humanDelay(2500, 3500);
    }

    cookies = await runSetCookieLoop(context, page, "after email step", 8000, 1000);
    if (cookies) return cookies;

    // ── 6. Password ──────────────────────────────────────────────────────────
    if (await visible(googlePage.locator('input[name="Passwd"], input[type="password"], #password input'))) {
      step("Entering password...");
      await pollAndFill(googlePage, "GooglePassword", [
        { description: 'input[name="Passwd"]',   locatorFn: (p) => p.locator('input[name="Passwd"]') },
        { description: 'input[type="password"]', locatorFn: (p) => p.locator('input[type="password"]') },
        { description: '#password input',        locatorFn: (p) => p.locator('#password input') },
      ], account.password);
      await humanDelay(700, 1200);

      // ── 7. Next ──────────────────────────────────────────────────────────────
      await pollAndClick(googlePage, "PasswordNext", [
        { description: "#passwordNext",              locatorFn: (p) => p.locator("#passwordNext") },
        { description: 'button[jsname="LgbsSe"]',   locatorFn: (p) => p.locator('button[jsname="LgbsSe"]') },
        { description: 'getByRole button "Next"',    locatorFn: (p) => p.getByRole("button", { name: /^next$/i }) },
        { description: 'div[id="passwordNext"]',     locatorFn: (p) => p.locator('div[id="passwordNext"]') },
      ]);
      await humanDelay(2500, 3500);
    }

    // ── 8. Final Set Cookie drive ────────────────────────────────────────────
    // After the Google login has settled, give the accessibility dashboard a
    // generous reload-and-retry window. This is the catch-all that mirrors what
    // account 1 does on a fresh authenticated profile.
    cookies = await runSetCookieLoop(context, page, "after Google auth", 35000, 1500);
    if (cookies) return cookies;

    throw new Error("Set Cookie never produced an accessibility cookie");

  } finally {
    if (browser) { try { await browser.close(); } catch {} }
    await killChrome(chromeProcess, profileDir);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  // Account quota failures get blacklisted so a single dead Gmail profile does
  // not block the rest of the batch.
  const accounts  = loadAccounts();
  const blacklist = new Set();

  step(`Loaded ${accounts.length} account(s)`);
  ensureReadyProfiles(accounts);

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];

    if (blacklist.has(account.email)) {
      dbg(`Skipping blacklisted: ${account.email}`);
      continue;
    }

    if (!isProfileReady(account)) {
      warn(`${account.email} profile not ready — skipping; run browser_strength.js to refresh it`);
      continue;
    }

    console.log();
    step(`[${i + 1}/${accounts.length}] ${account.email}`);

    try {
      const cookies = await attemptAccount(account, i);

      saveCookies(cookies);
      console.log();
      ok(`Cookies retrieved (${cookies.length})`);
      ok(`Saved → ${COOKIE_OUT}`);
      console.log();
      process.exit(0);

    } catch (err) {
      if (err instanceof QuotaError) {
        warn(`${account.email} quota exhausted — blacklisting, trying next`);
        blacklist.add(account.email);
      } else {
        fail(`${account.email}: ${err.message}`);
      }
    }
  }

  console.log();
  fail("All accounts exhausted — no valid cookie obtained");
  process.exit(1);
}

main();
