export type WebDevicePlatform = 'desktop-chromium' | 'android-chrome' | 'ios-26' | 'unsupported';
export type WebSupportLevel = 'desktop' | 'beta' | 'experimental' | 'unsupported';

export type WebDeviceProfile = {
  platform: WebDevicePlatform;
  supportLevel: WebSupportLevel;
  mobile: boolean;
  initialWorkPixelBudget: number;
  maxFileBytes: number;
};

export type WebDeviceSignals = {
  userAgent: string;
  maxTouchPoints: number;
  deviceMemory?: number;
  hardwareConcurrency: number;
  mobileHint?: boolean;
  debugMode?: boolean;
};

const MIB = 1024 * 1024;
const DESKTOP_WORK_PIXELS = 8_000_000;
const LOW_MEMORY_DESKTOP_WORK_PIXELS = 6_000_000;
const MOBILE_WORK_PIXELS = 8_000_000;
const LOW_MEMORY_MOBILE_WORK_PIXELS = 4_000_000;

function parseIosMajorVersion(userAgent: string): number | null {
  const match = userAgent.match(/(?:CPU (?:iPhone )?OS|iPhone OS) (\d+)[_.]/iu);
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) ? version : null;
}

function isIosLike(signals: WebDeviceSignals): boolean {
  return (
    /iPad|iPhone|iPod/iu.test(signals.userAgent)
    || (/Macintosh/iu.test(signals.userAgent) && signals.maxTouchPoints > 1)
  );
}

function isChromiumDesktop(userAgent: string): boolean {
  return /(?:Chrome|Chromium|Edg)\/\d+/iu.test(userAgent)
    && !/(?:Android|CriOS|EdgiOS|EdgA)\b/iu.test(userAgent);
}

export function currentWebDeviceSignals(): WebDeviceSignals {
  const navigatorWithMemory = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { mobile?: boolean };
  };
  return {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    deviceMemory: navigatorWithMemory.deviceMemory,
    hardwareConcurrency: navigator.hardwareConcurrency,
    mobileHint: navigatorWithMemory.userAgentData?.mobile,
    debugMode: new URL(globalThis.location.href).searchParams.has('debug'),
  };
}

export function detectWebDeviceProfile(
  signals: WebDeviceSignals = currentWebDeviceSignals(),
): WebDeviceProfile {
  const ios = isIosLike(signals);
  const androidChrome = /Android/iu.test(signals.userAgent)
    && /Chrome\/\d+/iu.test(signals.userAgent)
    && !/(?:EdgA|OPR)\//iu.test(signals.userAgent);
  const iosMajor = ios ? parseIosMajorVersion(signals.userAgent) : null;
  const ios26 = ios
    && iosMajor !== null
    && iosMajor >= 26
    && /(?:Version|CriOS)\/\d+/iu.test(signals.userAgent);
  const desktopChromium = !ios && isChromiumDesktop(signals.userAgent);
  const mobile = Boolean(signals.mobileHint) || ios || /Android|Mobile/iu.test(signals.userAgent);

  let platform: WebDevicePlatform = 'unsupported';
  let supportLevel: WebSupportLevel = 'unsupported';
  if (androidChrome) {
    platform = 'android-chrome';
    supportLevel = 'beta';
  } else if (ios26) {
    platform = 'ios-26';
    supportLevel = 'experimental';
  } else if (desktopChromium) {
    platform = 'desktop-chromium';
    supportLevel = 'desktop';
  }

  const lowMemory = signals.deviceMemory !== undefined && signals.deviceMemory <= 4;
  let initialWorkPixelBudget = mobile
    ? lowMemory ? LOW_MEMORY_MOBILE_WORK_PIXELS : MOBILE_WORK_PIXELS
    : lowMemory ? LOW_MEMORY_DESKTOP_WORK_PIXELS : DESKTOP_WORK_PIXELS;
  if (signals.debugMode) initialWorkPixelBudget = Math.floor(initialWorkPixelBudget / 2);

  return {
    platform,
    supportLevel,
    mobile,
    initialWorkPixelBudget,
    maxFileBytes: (mobile ? 20 : 32) * MIB,
  };
}
