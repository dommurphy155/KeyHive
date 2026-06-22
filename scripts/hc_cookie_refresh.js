// cookie_refresh.js
"use strict";

const { chromium } = require("playwright");
const { spawn, execSync } = require("child_process");
const fs   = require("fs");
const path = require("path");
const os   = require("os");
const ROOT_DIR = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT_DIR, ".env") });

// ─── Config ────────────────────────────────────────────────────────────────
const LOGIN_URL    = "https://dashboard.hcaptcha.com/login?type=accessibility";
const CDP_PORT     = 9333;
const CDP_HOST     = "127.0.0.1";
const X_DISPLAY    = ":1";
const CHROME_LOG   = "/root/chrome-9333.log";
const COOKIE_OUT   = path.join(ROOT_DIR, "data", "hc_cookie.json");

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

// ─── Load accounts from GMAIL_ACCOUNTS JSON array ─────────────────────────
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

// ─── Save ALL hcaptcha cookies to disk ─────────────────────────────────────
function saveCookies(cookies) {
  fs.mkdirSync(path.dirname(COOKIE_OUT), { recursive: true });
  fs.writeFileSync(COOKIE_OUT, JSON.stringify(cookies, null, 2));
}

// ─── Port + profile utils ──────────────────────────────────────────────────
function killPort(port) {
  try { execSync(`fuser -k ${port}/tcp 2>/dev/null || true`); } catch {}
}

function cleanupProfile(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ─── Spawn Chrome ──────────────────────────────────────────────────────────
function launchChrome(profileDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "google-chrome-stable",
      [
        `--remote-debugging-port=${CDP_PORT}`,
        `--remote-debugging-address=${CDP_HOST}`,
        `--user-data-dir=${profileDir}`,
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled",
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

function killChrome(child) {
  if (!child || child.killed) return;
  try { child.kill("SIGTERM"); } catch { try { child.kill("SIGKILL"); } catch {} }
}

// ─── Poll primitives ───────────────────────────────────────────────────────
async function pollForAny(page, label, candidates, timeout = POLL_TIMEOUT) {
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

  try {
    const screenshotPath = `/root/fail_${label.replace(/\W+/g, "_")}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    fail(`[${label}] screenshot → ${screenshotPath}`);
  } catch {}

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

// ─── Cookie extraction ─────────────────────────────────────────────────────
async function extractHcCookies(context, page) {
  // Method 1 — CDP (catches HttpOnly + gives domain/expires)
  try {
    const cdp    = await context.newCDPSession(page);
    const result = await cdp.send("Network.getAllCookies");
    await cdp.detach();
    const all = result.cookies || [];
    dbg(`CDP returned ${all.length} cookies`);
    const hcCookies = all.filter(c =>
      c.domain.includes("hcaptcha.com") ||
      c.name.startsWith("hc") ||
      c.name === "session"
    );
    if (hcCookies.length > 0) return hcCookies;
  } catch (err) {
    dbg(`CDP extract failed: ${err.message}`);
  }

  // Method 2 — context.cookies()
  try {
    const all = await context.cookies(["https://dashboard.hcaptcha.com", "https://hcaptcha.com", "https://accounts.hcaptcha.com", "https://api.hcaptcha.com"]);
    const hcCookies = all.filter(c =>
      c.domain.includes("hcaptcha.com") ||
      c.name.startsWith("hc") ||
      c.name === "session"
    );
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
  for (const phrase of QUOTA_PHRASES) {
    if (bodyText.toLowerCase().includes(phrase)) throw new QuotaError(phrase);
  }
}

// ─── Single account attempt ────────────────────────────────────────────────
async function attemptAccount(account, idx) {
  const profileDir  = `/tmp/chrome-cookie-refresh-${process.pid}-${idx}`;
  let chromeProcess = null;
  let browser       = null;

  try {
    step("Starting Chrome...");
    killPort(CDP_PORT);
    chromeProcess = await launchChrome(profileDir);
    ok("Chrome ready");

    browser = await chromium.connectOverCDP(`http://${CDP_HOST}:${CDP_PORT}`);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page    = context.pages()[0]    ?? (await context.newPage());

    // ── 1. Navigate ─────────────────────────────────────────────────────────
    step("Loading hcaptcha login...");
    await page.goto(LOGIN_URL, { waitUntil: "networkidle", timeout: 30000 });
    await humanDelay(1500, 2500);

    // ── 2. Sign in with Google ───────────────────────────────────────────────
    step("Clicking Sign in with Google...");
    await pollAndClick(page, "SignInWithGoogle", [
      { description: 'getByRole button "sign in with google"', locatorFn: (p) => p.getByRole("button", { name: /sign in with google/i }) },
      { description: 'getByRole link "sign in with google"',   locatorFn: (p) => p.getByRole("link",   { name: /sign in with google/i }) },
      { description: 'getByText "sign in with google"',        locatorFn: (p) => p.getByText(/sign in with google/i) },
      { description: '[aria-label*="google" i]',               locatorFn: (p) => p.locator('[aria-label*="google" i]') },
      { description: '[data-provider="google"]',               locatorFn: (p) => p.locator('[data-provider="google"]') },
      { description: 'a[href*="accounts.google.com"]',         locatorFn: (p) => p.locator('a[href*="accounts.google.com"]') },
    ]);
    await humanDelay(2500, 3500);

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
      try { await page.screenshot({ path: "/root/fail_no_google_page.png", fullPage: true }); } catch {}
      throw new Error("accounts.google.com never appeared — screenshot at /root/fail_no_google_page.png");
    }

    ok("Google auth opened");
    try { await googlePage.waitForLoadState("domcontentloaded", { timeout: 10000 }); } catch {}
    await humanDelay(1000, 2000);

    // ── 4. Email ─────────────────────────────────────────────────────────────
    step(`Entering email (${account.email})...`);
    await pollAndFill(googlePage, "GoogleEmail", [
      { description: 'input[name="identifier"]', locatorFn: (p) => p.locator('input[name="identifier"]') },
      { description: "#identifierId",            locatorFn: (p) => p.locator("#identifierId") },
      { description: 'input[type="email"]',      locatorFn: (p) => p.locator('input[type="email"]') },
    ], account.email);
    await humanDelay(700, 1200);

    // ── 5. Next ──────────────────────────────────────────────────────────────
    await pollAndClick(googlePage, "EmailNext", [
      { description: "#identifierNext",           locatorFn: (p) => p.locator("#identifierNext") },
      { description: 'button[jsname="LgbsSe"]',  locatorFn: (p) => p.locator('button[jsname="LgbsSe"]') },
      { description: 'getByRole button "Next"',   locatorFn: (p) => p.getByRole("button", { name: /^next$/i }) },
      { description: 'div[id="identifierNext"]',  locatorFn: (p) => p.locator('div[id="identifierNext"]') },
    ]);
    await humanDelay(2500, 3500);

    // ── 6. Password ──────────────────────────────────────────────────────────
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

    step("Waiting for dashboard...");
    await humanDelay(4000, 6000);

    // ── 8. Find Set Cookie button ────────────────────────────────────────────
    let dashPage    = null;
    let setCookieEl = null;
    const dDeadline = Date.now() + 30000;

    while (Date.now() < dDeadline) {
      for (const pg of context.pages()) {
        try {
          const loc = pg.getByRole("button", { name: /set cookie/i });
          if (await loc.count() > 0 && await loc.first().isVisible()) {
            dashPage = pg; setCookieEl = loc.first(); break;
          }
        } catch {}
        try {
          const loc = pg.locator("button").filter({ hasText: /set cookie/i });
          if (await loc.count() > 0 && await loc.first().isVisible()) {
            dashPage = pg; setCookieEl = loc.first(); break;
          }
        } catch {}
      }
      if (dashPage) break;
      await sleep(POLL_INTERVAL);
    }

    if (!dashPage || !setCookieEl) {
      try { await page.screenshot({ path: "/root/fail_SetCookie.png", fullPage: true }); } catch {}
      throw new Error("Set Cookie button never appeared — screenshot at /root/fail_SetCookie.png");
    }

    // Pre-click quota check
    try { checkBodyForQuota(await dashPage.innerText("body")); } catch (e) {
      if (e instanceof QuotaError) throw e;
    }

    // ── 9. Click Set Cookie ──────────────────────────────────────────────────
    step("Clicking Set Cookie...");
    await setCookieEl.scrollIntoViewIfNeeded();
    await humanDelay(500, 1000);
    await setCookieEl.click();
    await sleep(2500);

    // Post-click quota check
    try { checkBodyForQuota(await dashPage.innerText("body")); } catch (e) {
      if (e instanceof QuotaError) throw e;
    }

    // ── 10. Extract ──────────────────────────────────────────────────────────
    // Wait longer for the accessibility token to land
    await sleep(4000);

    const cookies = await extractHcCookies(context, dashPage);
    if (!cookies || cookies.length === 0) throw new Error("No hcaptcha cookies found after Set Cookie click");

    const hasAccessibilityToken = cookies.some(c =>
      c.name === "hc_at" || c.name.includes("accessibility") || c.name.startsWith("hc_a")
    );
    if (!hasAccessibilityToken) {
      warn("Accessibility token (hc_at) not found — waiting longer...");
      await sleep(5000);
      const retry = await extractHcCookies(context, dashPage);
      if (retry && retry.length > cookies.length) return retry;
    }

    return cookies;

  } finally {
    if (browser) { try { await browser.close(); } catch {} }
    killChrome(chromeProcess);
    cleanupProfile(profileDir);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const accounts  = loadAccounts();
  const blacklist = new Set();

  step(`Loaded ${accounts.length} account(s)`);

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];

    if (blacklist.has(account.email)) {
      dbg(`Skipping blacklisted: ${account.email}`);
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
