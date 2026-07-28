import { existsSync, mkdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { chromium } from "@playwright/test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DIST_DIR = join(ROOT, "apps", "extension", "dist");
const TMP_DIR = join(ROOT, ".tmp");
const USER_DATA_DIR = join(TMP_DIR, `browser-ocr-smoke-${Date.now()}`);
const USE_SYSTEM_CHROME = process.argv.includes("--system-chrome") || Boolean(process.env.CHROME_PATH);
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  ...(USE_SYSTEM_CHROME
    ? [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      ]
    : []),
].filter((value): value is string => !!value);

type SmokeResult = {
  extensionId: string;
  pageUrl: string;
  environment: {
    userAgent: string;
    secureContext: boolean;
    crossOriginIsolated: boolean;
    hasNavigatorGpu: boolean;
    hasNavigatorMl: boolean;
  };
  paddle: {
    modelKey: string;
    provider: string;
    inputNames: string[];
    outputNames: string[];
    outputDims: number[];
    outputClasses: number;
    outputLength: number;
    dictSize: number;
    expectedClasses: number;
    ok: boolean;
  };
};

function requireFile(relativePath: string): void {
  const fullPath = join(DIST_DIR, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Missing dist asset: ${fullPath}. Run npm run build first.`);
  }
}

function findChromeExecutable(): string | undefined {
  if (!USE_SYSTEM_CHROME) {
    return undefined;
  }
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("Chrome executable not found. Set CHROME_PATH to chrome.exe.");
}

async function main(): Promise<void> {
  requireFile("manifest.json");
  requireFile("popup.html");
  requireFile("content.js");
  requireFile("chunks/onnxWorkerBridge.js");
  requireFile("onnxWorker.js");
  requireFile("models/models.json");
  requireFile("models/PP-OCRv6_medium_rec.onnx");
  requireFile("models/paddleocr_v6_dict.txt");
  mkdirSync(USER_DATA_DIR, { recursive: true });

  const chromePath = findChromeExecutable();
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    ...(chromePath ? { executablePath: chromePath } : {}),
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${DIST_DIR}`,
      `--load-extension=${DIST_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--enable-unsafe-webgpu",
    ],
  });
  context.setDefaultTimeout(300000);

  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 30000 });
    const extensionId = worker.url().match(/^chrome-extension:\/\/([^/]+)/)?.[1];
    if (!extensionId) {
      throw new Error(`Unable to parse extension id from service worker URL: ${worker.url()}`);
    }

    const extensionUrl = (path: string) => `chrome-extension://${extensionId}/${path.replace(/^\/+/, "")}`;
    const page = await context.newPage();
    page.setDefaultTimeout(300000);
    page.on("console", (message) => {
      console.log(`[browser:${message.type()}] ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      console.log(`[pageerror] ${error.message}`);
    });

    await page.goto(extensionUrl("popup.html"), { waitUntil: "load" });
    await page.addScriptTag({ url: extensionUrl("content.js") });
    await page.waitForFunction(() => Boolean((window as any).__shinobu_shared), undefined, { timeout: 30000 });
    await page.evaluate("var __name = (target) => target;");

    const result = await page.evaluate<SmokeResult, string>(async (id) => {
      type RuntimeProvider = "webnn" | "webgpu" | "wasm";
      type SessionHandle = {
        sessionId: string;
        provider: RuntimeProvider;
        inputNames: string[];
        outputNames: string[];
      };
      type Bridge = {
        createSession(modelKey: string, modelUrl: string, preferred: RuntimeProvider[]): Promise<SessionHandle>;
        runInference(
          sessionId: string,
          feeds: Record<string, { data: Float32Array | BigInt64Array | Uint8Array; dims: number[]; type: "float32" | "int64" | "bool" }>
        ): Promise<{
          outputs: Record<string, { data: Float32Array | BigInt64Array | Uint8Array; dims: number[]; type: "float32" | "int64" | "bool" }>;
          error?: string;
        }>;
        disposeAll(): Promise<void>;
      };

      const chromeApi = (globalThis as any).chrome;
      if (!chromeApi?.runtime?.getURL) {
        throw new Error("chrome.runtime.getURL is unavailable in extension page");
      }
      const toExtensionUrl = (path: string) => chromeApi.runtime.getURL(path.replace(/^\/+/, ""));
      const loadDictSize = async (path: string): Promise<number> => {
        const response = await fetch(toExtensionUrl(path));
        if (!response.ok) {
          throw new Error(`Failed to load dict ${path}: ${response.status}`);
        }
        const text = await response.text();
        return text.split(/\r?\n/g).filter((line) => line.length > 0).length;
      };

      const bridge = await import(toExtensionUrl("chunks/onnxWorkerBridge.js")) as Bridge;
      const preferred: RuntimeProvider[] = ["webgpu", "wasm"];
      try {
        const modelKey = "paddleocr_v6_medium_rec";
        const session = await bridge.createSession(modelKey, toExtensionUrl("models/PP-OCRv6_medium_rec.onnx"), preferred);
        const inputName = session.inputNames[0];
        const outputName = session.outputNames[0];
        if (!inputName || !outputName) {
          throw new Error(`Paddle smoke missing names for ${modelKey}`);
        }
        const inputHeight = 48;
        const inputWidth = 320;
        const inference = await bridge.runInference(session.sessionId, {
          [inputName]: {
            data: new Float32Array(3 * inputHeight * inputWidth),
            dims: [1, 3, inputHeight, inputWidth],
            type: "float32",
          },
        });
        if (inference.error) {
          throw new Error(`${modelKey} inference failed: ${inference.error}`);
        }
        const output = inference.outputs[outputName];
        if (!output) {
          throw new Error(`${modelKey} did not return ${outputName}`);
        }
        const dictSize = await loadDictSize("models/paddleocr_v6_dict.txt");
        const outputClasses = output.dims[output.dims.length - 1] ?? 0;
        const expectedClasses = dictSize + 2;

        return {
          extensionId: id,
          pageUrl: location.href,
          environment: {
            userAgent: navigator.userAgent,
            secureContext: isSecureContext,
            crossOriginIsolated,
            hasNavigatorGpu: Boolean(navigator.gpu),
            hasNavigatorMl: Boolean((navigator as any).ml),
          },
          paddle: {
            modelKey,
            provider: session.provider,
            inputNames: session.inputNames,
            outputNames: session.outputNames,
            outputDims: output.dims,
            outputClasses,
            outputLength: output.data.length,
            dictSize,
            expectedClasses,
            ok: outputClasses === expectedClasses,
          },
        };
      } finally {
        await bridge.disposeAll();
      }
    }, extensionId);

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context.close();
  }
}

await main();
