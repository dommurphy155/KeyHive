// Browser bootstrap for Gmail-backed hCaptcha access.
// This script logs each Gmail account into Google, reaches the hCaptcha
// accessibility dashboard, and saves both the Playwright storage state and
// readiness metadata that hc_cookie_refresh.js relies on later.
"use strict";

const { chromium } = require("playwright");
const { spawn, spawnSync, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ROOT_DIR = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT_DIR, ".env") });

// These are the browser targets used during the Google login and hCaptcha
// accessibility flow. They are intentionally hard-coded because the page flow
// depends on stable public URLs, not project config.
const GMAIL_WORKSPACE_URL = "https://workspace.google.com/intl/en-US/gmail/";
const GMAIL_URL = "https://mail.google.com/";
const GOOGLE_ACCOUNT_URL = "https://myaccount.google.com/";
const HCAPTCHA_URL = "https://dashboard.hcaptcha.com/login?type=accessibility";
const CDP_PORT = Number(process.env.BROWSER_STRENGTH_CDP_PORT || 9333);
const CDP_HOST = "127.0.0.1";
const X_DISPLAY = process.env.DISPLAY || ":1";
// Account-specific Chrome profiles live under profiles/google/<sanitized-email>.
// The Playwright storage state lives under data/browser_strength so the refresh
// script can prove the profile actually finished the full flow.
const PROFILE_ROOT = path.join(ROOT_DIR, "profiles", "google");
const STATE_DIR = path.join(ROOT_DIR, "data", "browser_strength");
const ACCOUNT_STATUS_PATH = path.join(STATE_DIR, "accounts.json");
const CHROME_LOG = path.join(ROOT_DIR, "logs", `chrome-${CDP_PORT}.log`);

const POLL_TIMEOUT = 20000;
const POLL_INTERVAL = 300;
const MANUAL_TIMEOUT = 10 * 60 * 1000;

const MANUAL_PATTERNS = [
  /2-step verification/i,
  /2-factor/i,
  /verify it'?s you/i,
  /verify your identity/i,
  /recovery email/i,
  /recovery phone/i,
  /suspicious/i,
  /unusual activity/i,
  /couldn'?t verify/i,
  /confirm.*recovery/i,
  /captcha/i,
  /enter the code/i,
  /check your phone/i,
  /this browser or app may not be secure/i,
];

// When Google or hCaptcha throws a verification wall, the script stops and
// leaves the visible browser open for manual completion instead of trying to
// brute-force around it.
const ts = () => new Date().toISOString().slice(11, 19);
const step = (msg) => console.log(`[${ts()}] > ${msg}`);
const ok = (msg) => console.log(`[${ts()}] OK ${msg}`);
const warn = (msg) => console.log(`[${ts()}] WARN ${msg}`);
const fail = (msg) => console.error(`[${ts()}] ERR ${msg}`);
const dbg = (msg) => { if (process.env.DEBUG) console.log(`[${ts()}]    ${msg}`); };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const humanDelay = (min = 500, max = 1200) => sleep(min + Math.random() * (max - min));

class ManualActionError extends Error {
  constructor(email, reason) {
    super(`Manual action required for ${email}: ${reason}`);
    this.name = "ManualActionError";
    this.email = email;
    this.reason = reason;
  }
}

function warnAboutAutomation() {
  console.log();
  warn("Automated Google login only works reliably with owned test accounts where 2FA, recovery prompts, CAPTCHA, or manual verification will not block the flow.");
  warn("If Google asks for manual action, this script pauses and leaves the visible browser for you. It does not bypass CAPTCHA or 2FA.");
  console.log();
}

function safeEmail(email) {
  // Convert the email into a filesystem-safe profile directory name.
  return String(email).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
}

function profileDirFor(email) {
  return path.join(PROFILE_ROOT, safeEmail(email));
}

function storageStatePathFor(email) {
  return path.join(STATE_DIR, `${safeEmail(email)}.storage_state.json`);
}

function ensureDirs() {
  fs.mkdirSync(PROFILE_ROOT, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(CHROME_LOG), { recursive: true });
}

function loadAccounts() {
  const raw = process.env.GMAIL_ACCOUNTS;
  if (!raw) {
    throw new Error('Missing GMAIL_ACCOUNTS in .env. Expected: GMAIL_ACCOUNTS=[{"email":"x@gmail.com","password":"y"}]');
  }

  let accounts;
  try {
    accounts = JSON.parse(raw);
  } catch (err) {
    throw new Error(`GMAIL_ACCOUNTS parse error: ${err.message}`);
  }

  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error("GMAIL_ACCOUNTS must be a non-empty JSON array");
  }

  const seen = new Set();
  return accounts.map((account, index) => {
    if (!account || typeof account !== "object") throw new Error(`GMAIL_ACCOUNTS[${index}] must be an object`);
    if (!account.email || !account.password) throw new Error(`GMAIL_ACCOUNTS[${index}] is missing email/password`);

    const email = String(account.email).trim();
    if (!email) throw new Error(`GMAIL_ACCOUNTS[${index}] has an empty email`);
    const key = email.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate Gmail account in .env: ${email}`);
    seen.add(key);

    return { email, password: String(account.password) };
  });
}

function parseArgs(argv) {
  const opts = { emails: null, force: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") {
      opts.force = true;
    } else if (arg === "--email") {
      const value = argv[++i];
      if (!value) throw new Error("--email requires an address");
      opts.emails = [value.trim().toLowerCase()];
    } else if (arg.startsWith("--email=")) {
      opts.emails = [arg.slice("--email=".length).trim().toLowerCase()];
    } else if (arg === "--only") {
      const value = argv[++i];
      if (!value) throw new Error("--only requires a comma-separated email list");
      opts.emails = value.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
    } else if (arg.startsWith("--only=")) {
      opts.emails = arg.slice("--only=".length).split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

function readAccountStatus() {
  // The status file is a persistent checkpoint so later runs can skip accounts
  // that already have a live profile and saved storage state.
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

function isAccountReady(account) {
  const status = readAccountStatus()[account.email];
  if (!status) return false;

  const profileDir = statusPath(status.profileDir);
  const storageStatePath = statusPath(status.storageStatePath);

  return status.googleLoggedIn === true &&
    status.gmailChecked === true &&
    status.hcaptchaReachable === true &&
    status.setCookieVisible === true &&
    Boolean(profileDir) &&
    Boolean(storageStatePath) &&
    fs.existsSync(profileDir) &&
    fs.statSync(profileDir).isDirectory() &&
    fs.existsSync(storageStatePath) &&
    fs.statSync(storageStatePath).isFile();
}

function writeAccountStatus(status) {
  fs.mkdirSync(path.dirname(ACCOUNT_STATUS_PATH), { recursive: true });
  fs.writeFileSync(ACCOUNT_STATUS_PATH, JSON.stringify(status, null, 2) + "\n");
}

function updateAccountStatus(account, patch) {
  // Keep the per-account state file in sync with the current profile/session
  // state. This is what makes the refresh script idempotent.
  const status = readAccountStatus();
  status[account.email] = {
    profileDir: profileDirFor(account.email),
    storageStatePath: storageStatePathFor(account.email),
    googleLoggedIn: false,
    gmailChecked: false,
    hcaptchaReachable: false,
    setCookieVisible: false,
    lastCheckedAt: new Date().toISOString(),
    ...status[account.email],
    ...patch,
    lastCheckedAt: new Date().toISOString(),
  };
  writeAccountStatus(status);
}

function killPort(port) {
  try { execSync(`fuser -k ${port}/tcp 2>/dev/null || true`); } catch {}
}

async function killProfileChrome(profileDir) {
  // Kill any stray Chrome process that is still holding the account profile.
  spawnSync("pkill", ["-TERM", "-f", `--user-data-dir=${profileDir}`], { stdio: "ignore" });
  await sleep(1200);
  spawnSync("pkill", ["-KILL", "-f", `--user-data-dir=${profileDir}`], { stdio: "ignore" });
}

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
        // These flags keep Chrome stable inside the visible browser session and
        // reduce the obvious automation fingerprints that break Google flows.
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
        env: { ...process.env, DISPLAY: X_DISPLAY },
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    const logStream = fs.createWriteStream(CHROME_LOG, { flags: "a" });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);

    child.on("error", (err) => reject(new Error(`Chrome spawn failed: ${err.message}`)));
    child.on("exit", (code, sig) => dbg(`Chrome exited (code=${code} sig=${sig})`));

    let done = false;
    const deadline = Date.now() + 20000;
    // Wait for Chrome to expose the DevTools endpoint before handing it to
    // Playwright. If this never appears, the profile or Chrome launch is bad.
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
          reject(new Error("CDP never came alive within 20s"));
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

async function bodyText(page) {
  try { return await page.locator("body").innerText({ timeout: 3000 }); } catch { return ""; }
}

async function visible(locator) {
  try {
    return (await locator.count()) > 0 && await locator.first().isVisible();
  } catch {
    return false;
  }
}

async function pollForAny(page, label, candidates, timeout = POLL_TIMEOUT) {
  // Google and hCaptcha both A/B-test their DOM. This helper keeps a list of
  // fallback locators and uses the first visible one instead of betting on a
  // single selector.
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const { description, locatorFn } of candidates) {
      try {
        const loc = locatorFn(page);
        if (await visible(loc)) {
          dbg(`[${label}] hit: ${description}`);
          return { locator: loc.first(), description };
        }
      } catch {}
    }
    await sleep(POLL_INTERVAL);
  }
  throw new Error(`[${label}] nothing visible after ${timeout}ms`);
}

async function pollAndClick(page, label, candidates, timeout = POLL_TIMEOUT) {
  const { locator } = await pollForAny(page, label, candidates, timeout);
  await locator.scrollIntoViewIfNeeded();
  await humanDelay(250, 650);
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

async function detectManualAction(page) {
  // If Google throws a challenge page, this returns a reason string so the run
  // can pause for human input instead of pretending the flow can recover itself.
  if (await hasPasswordField(page)) return null;

  const text = await bodyText(page);
  const match = MANUAL_PATTERNS.find((pattern) => pattern.test(text));
  if (match) return match.toString();

  const url = page.url();
  if (/challenge\/pwd/i.test(url)) return null;
  if (/signin\/v2\/challenge|challenge\/ipp|challenge\/selection|speedbump|recovery|captcha/i.test(url)) return url;
  return null;
}

async function waitForManualAction(account, page) {
  const reason = await detectManualAction(page);
  if (!reason) return false;

  console.log();
  warn(`Manual action required for ${account.email}`);
  warn(`Reason: ${reason}`);
  // The browser stays visible here because the user may need to solve 2FA,
  // recovery, or CAPTCHA in the real UI before the script can continue.
  warn("Complete the visible Google prompt, then press Enter here. Type 'skip' and press Enter to move on.");
  console.log();

  if (!process.stdin.isTTY) {
    warn(`No interactive TTY available; skipping ${account.email}`);
    throw new ManualActionError(account.email, reason);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("skip"), MANUAL_TIMEOUT);
    rl.question(`[${account.email}] manual action complete? `, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  rl.close();

  const normalized = String(answer).trim().toLowerCase();
  if (normalized === "skip") {
    throw new ManualActionError(account.email, reason);
  }

  if (normalized === "") {
    step(`Manual action confirmed for ${account.email}`);
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await humanDelay(1200, 2200);

  const stillBlocked = await detectManualAction(page);
  if (stillBlocked) {
    throw new ManualActionError(account.email, stillBlocked);
  }

  return true;
}

async function selectGoogleAccountIfShown(page, account) {
  const candidates = [
    () => page.getByText(account.email, { exact: true }),
    () => page.locator(`[data-email="${account.email}"]`),
    () => page.locator(`div[role="link"]:has-text("${account.email}")`),
  ];

  for (const locatorFn of candidates) {
    try {
      const loc = locatorFn();
      if (await visible(loc)) {
        step(`Selecting existing Google session for ${account.email}`);
        await loc.first().click();
        await humanDelay(1500, 2500);
        return true;
      }
    } catch {}
  }

  return false;
}

async function accountChooserHasAccount(page, account) {
  const candidates = [
    () => page.getByText(account.email, { exact: true }),
    () => page.locator(`[data-email="${account.email}"]`),
    () => page.locator(`div[role="link"]:has-text("${account.email}")`),
  ];

  for (const locatorFn of candidates) {
    try {
      if (await visible(locatorFn())) return true;
    } catch {}
  }

  return false;
}

async function hasEmailField(page) {
  return await visible(page.locator('input[name="identifier"], #identifierId, input[type="email"]'));
}

async function hasPasswordField(page) {
  return await visible(page.locator('input[name="Passwd"], input[type="password"], #password input'));
}

async function googleErrorText(page) {
  const text = await bodyText(page);
  const patterns = [
    /couldn'?t find your google account/i,
    /wrong password/i,
    /couldn'?t sign you in/i,
    /try again later/i,
    /this browser or app may not be secure/i,
    /unable to sign in/i,
  ];
  const hit = patterns.find((pattern) => pattern.test(text));
  return hit ? hit.toString() : null;
}

async function findPage(context, predicate, timeout = POLL_TIMEOUT) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const pg of context.pages()) {
      try {
        if (await predicate(pg)) return pg;
      } catch {}
    }
    await sleep(POLL_INTERVAL);
  }
  return null;
}

async function findAccountPage(context, fallbackPage) {
  return await findPage(context, (pg) => pg.url().includes("accounts.google.com"), 15000) || fallbackPage;
}

async function clickGmailWorkspaceSignIn(context, page) {
  // The Gmail landing page is just a convenient launch pad; the page copy and
  // link structure vary, so this uses several selectors to find the sign-in
  // entry point across Google variants.
  step("Opening Gmail Workspace landing page");
  await page.goto(GMAIL_WORKSPACE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await humanDelay(1200, 2200);

  step("Clicking Gmail Sign in");
  const before = new Set(context.pages());
  await pollAndClick(page, "GmailWorkspaceSignIn", [
    { description: 'a[aria-label="Sign into Gmail"]', locatorFn: (p) => p.locator('a[aria-label="Sign into Gmail"]') },
    { description: 'a[href*="AccountChooser"]', locatorFn: (p) => p.locator('a[href*="AccountChooser"]') },
    { description: 'a[href*="mail.google.com"]', locatorFn: (p) => p.locator('a[href*="mail.google.com"]').filter({ hasText: /^sign in$/i }) },
    { description: 'role link "Sign in"', locatorFn: (p) => p.getByRole("link", { name: /^sign in$/i }) },
    { description: 'role button "Sign in"', locatorFn: (p) => p.getByRole("button", { name: /^sign in$/i }) },
    { description: 'text "Sign in"', locatorFn: (p) => p.getByText(/^sign in$/i) },
  ]);

  await humanDelay(1500, 2500);
  const newPage = context.pages().find((pg) => !before.has(pg));
  return newPage || await findAccountPage(context, page);
}

async function isGmailLoggedIn(page, account) {
  // Gmail login is considered good when the page stays on mail.google.com and
  // either the account chooser or inbox-like content confirms the account.
  await page.goto(GMAIL_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await humanDelay(2500, 4500);
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  const url = page.url();
  if (url.includes("accounts.google.com")) {
    return await accountChooserHasAccount(page, account);
  }

  const text = await bodyText(page);
  if (/choose an account|to continue to gmail/i.test(text)) {
    return await accountChooserHasAccount(page, account);
  }
  if (/sign in/i.test(text) && !text.toLowerCase().includes(account.email.toLowerCase())) return false;
  if (text.toLowerCase().includes(account.email.toLowerCase())) return true;
  if (url.includes("mail.google.com") && /inbox|compose|gmail|mail/i.test(text)) return true;

  return url.includes("mail.google.com") && !url.includes("ServiceLogin");
}

async function isGoogleAccountLoggedIn(page, account) {
  await page.goto(GOOGLE_ACCOUNT_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await humanDelay(1500, 2500);

  if (page.url().includes("accounts.google.com")) return false;

  const text = await bodyText(page);
  if (/sign in/i.test(text) && /google account/i.test(text)) return false;
  if (text.toLowerCase().includes(account.email.toLowerCase())) return true;
  return /manage your google account|personal info|data & privacy|security/i.test(text);
}

async function ensureGmailLogin(context, page, account) {
  // This is the main Google login state machine: reuse an existing session when
  // possible, otherwise walk the email/password challenge and stop for manual
  // intervention when Google insists on it.
  if (await isGmailLoggedIn(page, account)) return "already";

  const loginPage = await clickGmailWorkspaceSignIn(context, page);
  const activePage = await findAccountPage(context, loginPage);
  const checkPage = activePage === page ? await context.newPage() : page;
  await activePage.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await humanDelay(1000, 1800);

  await selectGoogleAccountIfShown(activePage, account);
  await waitForManualAction(account, activePage);

  if (await isGmailLoggedIn(checkPage, account)) return "success";

  if (await hasEmailField(activePage)) {
    step(`Entering email for ${account.email}`);
    await pollAndFill(activePage, "GoogleEmail", [
      { description: 'input[name="identifier"]', locatorFn: (p) => p.locator('input[name="identifier"]') },
      { description: "#identifierId", locatorFn: (p) => p.locator("#identifierId") },
      { description: 'input[type="email"]', locatorFn: (p) => p.locator('input[type="email"]') },
    ], account.email);
    await humanDelay(600, 1100);
    await pollAndClick(activePage, "EmailNext", [
      { description: "#identifierNext", locatorFn: (p) => p.locator("#identifierNext") },
      { description: 'button[jsname="LgbsSe"]', locatorFn: (p) => p.locator('button[jsname="LgbsSe"]') },
      { description: 'button "Next"', locatorFn: (p) => p.getByRole("button", { name: /^next$/i }) },
    ]);
    await humanDelay(2500, 4000);
  }

  await waitForManualAction(account, activePage);
  const emailError = await googleErrorText(activePage);
  if (emailError) throw new Error(`Google login stopped after email step: ${emailError}`);

  const passwordDeadline = Date.now() + 25000;
  while (!(await hasPasswordField(activePage)) && Date.now() < passwordDeadline) {
    if (await isGmailLoggedIn(checkPage, account)) return "success";
    await waitForManualAction(account, activePage);
    const err = await googleErrorText(activePage);
    if (err) throw new Error(`Google login stopped before password step: ${err}`);
    await sleep(1000);
  }

  if (!(await hasPasswordField(activePage))) {
    throw new Error("Google password field did not appear after email submission");
  }

  step(`Entering password for ${account.email}`);
  await pollAndFill(activePage, "GooglePassword", [
    { description: 'input[name="Passwd"]', locatorFn: (p) => p.locator('input[name="Passwd"]') },
    { description: 'input[type="password"]', locatorFn: (p) => p.locator('input[type="password"]') },
    { description: "#password input", locatorFn: (p) => p.locator("#password input") },
  ], account.password);
  await humanDelay(600, 1100);
  await pollAndClick(activePage, "PasswordNext", [
    { description: "#passwordNext", locatorFn: (p) => p.locator("#passwordNext") },
    { description: 'button[jsname="LgbsSe"]', locatorFn: (p) => p.locator('button[jsname="LgbsSe"]') },
    { description: 'button "Next"', locatorFn: (p) => p.getByRole("button", { name: /^next$/i }) },
  ]);
  await humanDelay(2500, 4000);

  const loginDeadline = Date.now() + 60000;
  while (Date.now() < loginDeadline) {
    await waitForManualAction(account, activePage);
    const err = await googleErrorText(activePage);
    if (err) throw new Error(`Google login stopped after password step: ${err}`);
    if (await isGmailLoggedIn(checkPage, account)) return "success";
    await sleep(1500);
  }

  throw new Error("Gmail login did not complete within timeout");
}

async function findSetCookiePage(context, timeout = POLL_TIMEOUT) {
  return await findPage(context, async (pg) => /set cookie/i.test(await bodyText(pg)), timeout);
}

async function confirmHcaptchaAccess(context, page, account) {
  // After Google login, the script opens the hCaptcha accessibility dashboard
  // and verifies the "Set Cookie" control is actually present before saving
  // the browser state.
  step(`Opening hCaptcha accessibility flow for ${account.email}`);
  await page.goto(HCAPTCHA_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await humanDelay(2000, 3000);

  let setCookiePage = await findSetCookiePage(context, 5000);
  if (setCookiePage) return { hcaptchaReachable: true, setCookieVisible: true, detail: "Set Cookie visible" };

  const text = await bodyText(page);
  if (/sign in with google/i.test(text)) {
    step("Signing into hCaptcha with Google");
    await pollAndClick(page, "HcaptchaGoogleSignIn", [
      { description: 'button "sign in with google"', locatorFn: (p) => p.getByRole("button", { name: /sign in with google/i }) },
      { description: 'link "sign in with google"', locatorFn: (p) => p.getByRole("link", { name: /sign in with google/i }) },
      { description: 'text "sign in with google"', locatorFn: (p) => p.getByText(/sign in with google/i) },
      { description: 'google href', locatorFn: (p) => p.locator('a[href*="accounts.google.com"]') },
    ], 10000);
    await humanDelay(2500, 3500);

    const accountPage = await findAccountPage(context, page);
    if (accountPage.url().includes("accounts.google.com")) {
      await selectGoogleAccountIfShown(accountPage, account);
      await waitForManualAction(account, accountPage);
    }
  }

  setCookiePage = await findSetCookiePage(context, 25000);
  if (setCookiePage) return { hcaptchaReachable: true, setCookieVisible: true, detail: "Set Cookie visible" };

  const finalPage = await findPage(context, (pg) => Promise.resolve(pg.url().includes("dashboard.hcaptcha.com")), 5000) || page;
  const finalText = await bodyText(finalPage);
  if (/sign in with google/i.test(finalText)) {
    return { hcaptchaReachable: false, setCookieVisible: false, detail: "hCaptcha still requires Google sign-in" };
  }

  return {
    hcaptchaReachable: finalPage.url().includes("dashboard.hcaptcha.com"),
    setCookieVisible: false,
    detail: "hCaptcha dashboard reached but Set Cookie was not visible",
  };
}

async function saveSessionState(context, account) {
  // Persist the full Playwright session so later runs can reuse the authenticated
  // browser state instead of replaying the login flow.
  const out = storageStatePathFor(account.email);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await context.storageState({ path: out });
  return out;
}

async function processAccount(account, index, total) {
  // One account = one visible Chrome instance, one profile, one checkpoint.
  // The updateAccountStatus calls let hc_cookie_refresh.js know whether this
  // account has already produced a reusable browser session.
  const profileDir = profileDirFor(account.email);
  let chromeProcess = null;
  let browser = null;

  console.log();
  step(`[${index + 1}/${total}] ${account.email}`);
  step(`Profile: ${profileDir}`);

  try {
    updateAccountStatus(account, {
      profileDir,
      storageStatePath: storageStatePathFor(account.email),
      error: null,
    });

    killPort(CDP_PORT);
    await killProfileChrome(profileDir);
    chromeProcess = await launchChrome(profileDir);
    browser = await chromium.connectOverCDP(`http://${CDP_HOST}:${CDP_PORT}`);

    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();

    const loginStatus = await ensureGmailLogin(context, page, account);
    const googleLoggedIn = await isGoogleAccountLoggedIn(page, account);
    if (!googleLoggedIn) throw new Error("Google account check failed after Gmail login");

    ok(loginStatus === "already" ? `${account.email} already logged into Gmail` : `${account.email} logged into Gmail`);
    updateAccountStatus(account, {
      profileDir,
      storageStatePath: storageStatePathFor(account.email),
      googleLoggedIn: true,
      gmailChecked: true,
      error: null,
    });

    const hcaptcha = await confirmHcaptchaAccess(context, page, account);
    if (!hcaptcha.hcaptchaReachable || !hcaptcha.setCookieVisible) throw new Error(hcaptcha.detail);

    const statePath = await saveSessionState(context, account);
    updateAccountStatus(account, {
      profileDir,
      googleLoggedIn: true,
      gmailChecked: true,
      hcaptchaReachable: true,
      setCookieVisible: true,
      storageStatePath: statePath,
      error: null,
    });

    ok(`${account.email} hCaptcha check: ${hcaptcha.detail}`);
    ok(`Session state saved: ${statePath}`);
    return loginStatus;
  } catch (err) {
    const previous = readAccountStatus()[account.email] || {};
    updateAccountStatus(account, {
      profileDir,
      storageStatePath: previous.storageStatePath || storageStatePathFor(account.email),
      googleLoggedIn: previous.googleLoggedIn === true,
      gmailChecked: previous.gmailChecked === true,
      hcaptchaReachable: false,
      setCookieVisible: false,
      error: err.message,
    });

    if (err instanceof ManualActionError) {
      warn(`${account.email} blocked by manual verification`);
      return { status: "blocked", error: err.message };
    }

    fail(`${account.email}: ${err.message}`);
    return { status: "failed", error: err.message };
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
    await killChrome(chromeProcess, profileDir);
    await sleep(800);
  }
}

function printSummary(summary) {
  // Summarize the batch so the operator can see which accounts are ready,
  // already-good, blocked by manual verification, or broken.
  console.log();
  console.log("Summary");
  console.log("-------");
  console.log(`successfully logged in: ${summary.success.length ? summary.success.join(", ") : "-"}`);
  console.log(`already logged in:      ${summary.already.length ? summary.already.join(", ") : "-"}`);
  console.log(`manual verification:    ${summary.blocked.length ? summary.blocked.join(", ") : "-"}`);
  console.log(`failed:                 ${summary.failed.length ? summary.failed.join(", ") : "-"}`);
}

async function main() {
  warnAboutAutomation();
  ensureDirs();

  const opts = parseArgs(process.argv.slice(2));
  const allAccounts = loadAccounts();
  const accounts = opts.emails
    ? allAccounts.filter((account) => opts.emails.includes(account.email.toLowerCase()))
    : allAccounts;

  if (opts.emails && accounts.length !== opts.emails.length) {
    const found = new Set(accounts.map((account) => account.email.toLowerCase()));
    const missing = opts.emails.filter((email) => !found.has(email));
    throw new Error(`Email(s) not found in GMAIL_ACCOUNTS: ${missing.join(", ")}`);
  }

  const summary = { success: [], already: [], blocked: [], failed: [] };
  step(`Loaded ${allAccounts.length} account(s) from .env`);
  if (opts.emails) step(`Targeted account(s): ${accounts.map((account) => account.email).join(", ")}`);
  if (opts.force) warn("--force set; rechecking ready account(s)");

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];

    if (!opts.force && isAccountReady(account)) {
      ok(`${account.email} already ready — skipping`);
      summary.already.push(account.email);
      continue;
    }

    if (!opts.force) step(`${account.email} not ready — preparing profile`);
    const result = await processAccount(account, i, accounts.length);

    if (result === "success") summary.success.push(account.email);
    else if (result === "already") summary.already.push(account.email);
    else if (result.status === "blocked") summary.blocked.push(account.email);
    else summary.failed.push(account.email);
  }

  printSummary(summary);
  if (summary.failed.length || summary.blocked.length) process.exit(1);
}

main().catch((err) => {
  fail(err.message);
  process.exit(1);
});
