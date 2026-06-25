// Manually add one hCaptcha accessibility browser profile.
// This opens a visible Chrome session, lets you complete the hCaptcha/Google
// login by hand, then marks the profile ready for hc_cookie_refresh.js.
"use strict";

const { chromium } = require("playwright");
const { spawn, spawnSync, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ROOT_DIR = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT_DIR, ".env") });

const LOGIN_URL = "https://dashboard.hcaptcha.com/login?type=accessibility";
const CDP_PORT = 9333;
const CDP_HOST = "127.0.0.1";
const X_DISPLAY = ":1";

const CHROME_LOG = path.join(ROOT_DIR, "logs", "chrome-9333.log");
const PROFILE_ROOT = path.join(ROOT_DIR, "profiles", "google");
const STRENGTH_DIR = path.join(ROOT_DIR, "data", "browser_strength");
const ACCOUNT_STATUS_PATH = path.join(STRENGTH_DIR, "accounts.json");

const ts = () => new Date().toISOString().slice(11, 19);
const step = (msg) => console.log(`[${ts()}] › ${msg}`);
const ok = (msg) => console.log(`[${ts()}] ✓ ${msg}`);
const warn = (msg) => console.log(`[${ts()}] ⚠ ${msg}`);
const fail = (msg) => console.error(`[${ts()}] ✗ ${msg}`);
const dbg = (msg) => { if (process.env.DEBUG) console.log(`[${ts()}]   ${msg}`); };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeProfileName(email) {
  return String(email)
    .trim()
    .toLowerCase()
    .replace(/[\/\\:*?"<>|\x00-\x1f]+/g, "_");
}

function safeStateName(email) {
  return String(email).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
}

function profileDirFor(email) {
  return path.join(PROFILE_ROOT, safeProfileName(email));
}

function storageStatePathFor(email) {
  return path.join(STRENGTH_DIR, `${safeStateName(email)}.storage_state.json`);
}

function cookiesPathFor(email) {
  return path.join(STRENGTH_DIR, `${safeStateName(email)}.cookies.json`);
}

function readAccountStatus() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNT_STATUS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeAccountStatus(status) {
  fs.mkdirSync(path.dirname(ACCOUNT_STATUS_PATH), { recursive: true });
  fs.writeFileSync(ACCOUNT_STATUS_PATH, JSON.stringify(status, null, 2) + "\n");
}

function updateAccountStatus(email, patch) {
  const status = readAccountStatus();
  status[email] = {
    profileDir: profileDirFor(email),
    storageStatePath: storageStatePathFor(email),
    googleLoggedIn: true,
    gmailChecked: true,
    hcaptchaReachable: true,
    setCookieVisible: true,
    lastCheckedAt: new Date().toISOString(),
    ...status[email],
    ...patch,
    lastCheckedAt: new Date().toISOString(),
  };
  writeAccountStatus(status);
}

function parseArgs(argv) {
  const opts = { email: null };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--email") {
      const value = argv[++i];
      if (!value) throw new Error("--email requires an address");
      opts.email = value.trim().toLowerCase();
    } else if (arg.startsWith("--email=")) {
      opts.email = arg.slice("--email=".length).trim().toLowerCase();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

function question(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function killPort(port) {
  try { execSync(`fuser -k ${port}/tcp 2>/dev/null || true`); } catch {}
}

function waitForProcessExit(child, timeout = 10000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeout);

    function onExit() {
      clearTimeout(timer);
      resolve(true);
    }

    child.once("exit", onExit);
  });
}

async function killProfileChrome(profileDir) {
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
  if (child && child.exitCode === null && child.signalCode === null && !child.killed) {
    try { child.kill("SIGTERM"); } catch {}
    const exited = await waitForProcessExit(child, 5000);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch {}
    }
  }
  if (profileDir) await killProfileChrome(profileDir);
  killPort(CDP_PORT);
}

async function saveAllBrowserState(context, page, storageStatePath, cookiesPath) {
  fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });

  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  const state = await context.storageState({ path: storageStatePath });
  let cookies = state.cookies || [];

  try {
    const cdp = await context.newCDPSession(page);
    const result = await cdp.send("Network.getAllCookies");
    await cdp.detach();
    if (Array.isArray(result.cookies)) cookies = result.cookies;
  } catch (err) {
    warn(`CDP cookie snapshot failed; using Playwright storageState cookies: ${err.message}`);
  }

  fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2) + "\n");
  return { cookieCount: cookies.length };
}

async function closeChromeCleanly(context, page, child) {
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Browser.close");
  } catch (err) {
    warn(`Graceful Chrome close failed: ${err.message}`);
  }

  return await waitForProcessExit(child, 15000);
}

function assertProfileSaved(profileDir, storageStatePath) {
  const defaultProfile = path.join(profileDir, "Default");
  if (!fs.existsSync(profileDir) || !fs.statSync(profileDir).isDirectory()) {
    throw new Error(`Profile directory was not saved: ${profileDir}`);
  }
  if (!fs.existsSync(defaultProfile) || !fs.statSync(defaultProfile).isDirectory()) {
    throw new Error(`Chrome Default profile was not saved: ${defaultProfile}`);
  }
  if (!fs.existsSync(storageStatePath) || !fs.statSync(storageStatePath).isFile()) {
    throw new Error(`Storage state was not saved: ${storageStatePath}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let browser = null;
  let chromeProcess = null;
  let profileDir = null;
  let chromeClosedCleanly = false;

  try {
    let email = opts.email;
    if (!email) {
      email = (await question(rl, "hCaptcha/Google email for this profile: ")).trim().toLowerCase();
    }
    if (!email || !email.includes("@")) throw new Error("A valid email address is required");

    profileDir = profileDirFor(email);
    const storageStatePath = storageStatePathFor(email);
    const cookiesPath = cookiesPathFor(email);

    fs.mkdirSync(PROFILE_ROOT, { recursive: true });
    fs.mkdirSync(STRENGTH_DIR, { recursive: true });

    step(`Profile: ${profileDir}`);
    if (fs.existsSync(profileDir) && fs.readdirSync(profileDir).length > 0) {
      warn("Profile already exists; Chrome will reuse it.");
    }

    killPort(CDP_PORT);
    await killProfileChrome(profileDir);

    step("Starting Chrome...");
    chromeProcess = await launchChrome(profileDir);
    ok("Chrome ready");

    browser = await chromium.connectOverCDP(`http://${CDP_HOST}:${CDP_PORT}`);
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();

    step("Loading hcaptcha login...");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((err) => {
      warn(`hCaptcha page load did not fully settle: ${err.message}`);
    });

    console.log();
    console.log("Use the visible Chrome window to sign into hCaptcha accessibility.");
    console.log("When the account is fully logged in and ready, press Enter here.");
    await question(rl, "");

    step("Saving browser state...");
    const saved = await saveAllBrowserState(context, page, storageStatePath, cookiesPath);

    step("Closing Chrome to flush profile...");
    chromeClosedCleanly = await closeChromeCleanly(context, page, chromeProcess);
    if (!chromeClosedCleanly) {
      throw new Error("Chrome did not close cleanly; not marking profile ready");
    }
    browser = null;

    assertProfileSaved(profileDir, storageStatePath);

    updateAccountStatus(email, {
      profileDir,
      storageStatePath,
      cookiesPath,
      googleLoggedIn: true,
      gmailChecked: true,
      hcaptchaReachable: true,
      setCookieVisible: true,
      error: null,
      addedManually: true,
    });

    ok(`Profile saved: ${profileDir}`);
    ok(`Session state saved: ${storageStatePath}`);
    ok(`Cookie snapshot saved: ${cookiesPath} (${saved.cookieCount})`);
  } finally {
    rl.close();
    if (!chromeClosedCleanly) {
      if (browser) { try { await browser.close(); } catch {} }
      await killChrome(chromeProcess, profileDir);
    } else {
      killPort(CDP_PORT);
    }
  }
}

main().catch((err) => {
  fail(err.message);
  process.exit(1);
});
