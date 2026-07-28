import { describe, expect, it } from 'vitest';
import {
  detectWebDeviceProfile,
  type WebDeviceSignals,
} from '../../apps/web/src/runtime/deviceProfile';
import {
  imageImportLimitsForDevice,
  MOBILE_IMAGE_IMPORT_LIMITS,
} from '../../apps/web/src/features/import/imageImporter';

function signals(patch: Partial<WebDeviceSignals>): WebDeviceSignals {
  return {
    userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
    maxTouchPoints: 0,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    ...patch,
  };
}

describe('Web device capability profile', () => {
  it('classifies desktop Chromium and lowers the initial tier on low-memory devices', () => {
    const normal = detectWebDeviceProfile(signals({}));
    const constrained = detectWebDeviceProfile(signals({ deviceMemory: 4 }));

    expect(normal).toMatchObject({
      platform: 'desktop-chromium',
      supportLevel: 'desktop',
      mobile: false,
      initialWorkPixelBudget: 8_000_000,
    });
    expect(constrained.initialWorkPixelBudget).toBe(6_000_000);
  });

  it('marks Android Chrome beta and enforces the 20 MiB mobile file gate', () => {
    const profile = detectWebDeviceProfile(signals({
      userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36',
      maxTouchPoints: 5,
      mobileHint: true,
    }));

    expect(profile).toMatchObject({
      platform: 'android-chrome',
      supportLevel: 'beta',
      mobile: true,
      maxFileBytes: 20 * 1024 * 1024,
    });
  });

  it('only marks iOS/iPadOS 26+ as experimental', () => {
    const ios26 = detectWebDeviceProfile(signals({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1',
      maxTouchPoints: 5,
      deviceMemory: undefined,
      mobileHint: true,
    }));
    const ios25 = detectWebDeviceProfile(signals({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 25_4 like Mac OS X) AppleWebKit/605.1.15 Version/25.4 Mobile/15E148 Safari/604.1',
      maxTouchPoints: 5,
      deviceMemory: undefined,
      mobileHint: true,
    }));

    expect(ios26.supportLevel).toBe('experimental');
    expect(ios25.supportLevel).toBe('unsupported');
  });

  it('keeps Firefox and desktop Safari outside the first inference release', () => {
    expect(detectWebDeviceProfile(signals({
      userAgent: 'Mozilla/5.0 Firefox/141.0',
    })).supportLevel).toBe('unsupported');
    expect(detectWebDeviceProfile(signals({
      userAgent: 'Mozilla/5.0 (Macintosh) Version/26.0 Safari/605.1.15',
    })).supportLevel).toBe('unsupported');
  });
});

describe('device-specific image import limits', () => {
  it('uses the mobile file ceiling and clamps unsafe work-pixel requests', () => {
    expect(MOBILE_IMAGE_IMPORT_LIMITS.maxFileBytes).toBe(20 * 1024 * 1024);
    expect(imageImportLimitsForDevice(true, 20_000_000)).toMatchObject({
      maxFileBytes: 20 * 1024 * 1024,
      workPixelBudget: 12_000_000,
    });
    expect(imageImportLimitsForDevice(false, 100)).toMatchObject({
      maxFileBytes: 32 * 1024 * 1024,
      workPixelBudget: 1_000_000,
    });
  });
});
