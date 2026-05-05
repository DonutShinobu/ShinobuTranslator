import { launchWindowsChrome } from "./chrome-cdp";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { extname, join, resolve } from "path";
import { execSync } from "child_process";
import { createServer } from "http";

const ROOT = resolve(import.meta.dirname, "../..");
const IMAGES_DIR = join(ROOT, "benchmark/images");
const REPORTS_DIR = join(ROOT, "benchmark/reports");
const DIST_DIR = join(ROOT, "dist");

function imageToDataUrl(path: string): string {
  const ext = extname(path).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  const buf = readFileSync(path);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function findLatestReportDir(): string | null {
  if (!existsSync(REPORTS_DIR)) return null;
  const dirs = readdirSync(REPORTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();
  return dirs.length > 0 ? join(REPORTS_DIR, dirs[0]) : null;
}

async function main(): Promise<void> {
  console.log("Building extension...");
  execSync("npm run build", { cwd: ROOT, stdio: "inherit" });

  const manifestPath = join(DIST_DIR, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  manifest.content_scripts[0].matches = ["http://localhost/*", ...manifest.content_scripts[0].matches];
  if (!manifest.host_permissions) manifest.host_permissions = [];
  if (!manifest.host_permissions.includes("http://localhost/*")) {
    manifest.host_permissions.push("http://localhost/*");
  }
  if (!manifest.permissions) manifest.permissions = [];
  if (!manifest.permissions.includes("scripting")) {
    manifest.permissions.push("scripting");
  }
  for (const war of manifest.web_accessible_resources ?? []) {
    if (!war.matches.includes("http://localhost/*")) {
      war.matches.push("http://localhost/*");
    }
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = (server.address() as any).port;
  const localUrl = `http://localhost:${port}/`;

  const imageFiles = readdirSync(IMAGES_DIR).filter((f) =>
    /\.(png|jpe?g|webp)$/i.test(f),
  );
  if (imageFiles.length === 0) {
    console.error("No images found in benchmark/images/");
    process.exit(1);
  }

  const reportDir = findLatestReportDir();
  const outputDir = reportDir ?? join(REPORTS_DIR, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(outputDir, { recursive: true });

  const { browser, close: closeBrowser } = await launchWindowsChrome(DIST_DIR);
  const context = browser.contexts()[0];

  for (const imgFile of imageFiles) {
    console.log(`Rendering: ${imgFile}`);
    const imgPath = join(IMAGES_DIR, imgFile);
    const dataUrl = imageToDataUrl(imgPath);

    const page = await context.newPage();
    page.on("console", (msg) => console.log(`  [browser ${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (err) => console.log(`  [pageerror] ${err.message}`));

    await page.addInitScript(`
      window.__shinobu_bridge_ready__ = false;
      window.addEventListener("message", (e) => {
        if (e.data?.type === "__shinobu_bake_ready__") {
          window.__shinobu_bridge_ready__ = true;
        }
      });
    `);

    await page.goto(localUrl, { waitUntil: "load" });
    await page.waitForFunction('window.__shinobu_bridge_ready__ === true', { timeout: 15_000 });

    await page.evaluate((du: string) => { (window as any).__render_dataUrl__ = du; }, dataUrl);
    const resultDataUrl: string = await page.evaluate(`
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Render timeout")), 120000);
        const handler = (e) => {
          if (e.data?.type !== "__shinobu_render_response__") return;
          window.removeEventListener("message", handler);
          clearTimeout(timeout);
          if (e.data.error) reject(new Error(e.data.error));
          else resolve(e.data.result);
        };
        window.addEventListener("message", handler);
        window.postMessage({ type: "__shinobu_render_request__", dataUrl: window.__render_dataUrl__ }, "*");
      })
    `);

    const base64 = resultDataUrl.replace(/^data:image\/png;base64,/, "");
    const outName = imgFile.replace(/\.[^.]+$/, "") + "_render.png";
    writeFileSync(join(outputDir, outName), Buffer.from(base64, "base64"));
    console.log(`  -> ${outName}`);
    await page.close();
  }

  await closeBrowser();
  server.close();
  console.log(`Render complete. Output: ${outputDir}`);
}

main();
