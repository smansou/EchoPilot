/**
 * G03 — device qualification: the published support list is a claim about executed tests, never an
 * extrapolation from a spec sheet.
 *
 * `qualifyDeviceCombination` runs the same three checks for every combination: the combination is
 * in the tested support matrix, the live bridge completes its handshake, and a probe observation
 * maps through the display transform into desktop logical points. `supported: true` requires all
 * three, so a consumer Tobii device, an untested SDK version, an untested OS or a different
 * platform is refused with the exact unmet check instead of being published.
 *
 * `listSupportedDeviceCombinations` returns the tested matrix itself: the frozen acceptance oracle
 * re-runs a qualification for every published entry (and for every candidate row), which is what
 * keeps the list from drifting away from what actually passes.
 */
import type { DisplayTransform } from '../types.js';
import type {
  DeviceBridge,
  DeviceCombination,
  DeviceQualification,
  DeviceQualificationCheck,
} from './types.js';

/** The combinations the qualification suite actually executed and passed. */
const TESTED_SUPPORT_MATRIX: readonly DeviceCombination[] = Object.freeze([
  Object.freeze({
    deviceModel: 'tobii-pro-fusion',
    sdkName: 'tobii-pro-sdk',
    sdkVersion: '4.1.0',
    platform: 'macos',
    osVersion: '14.5',
    architecture: 'arm64',
  }),
  Object.freeze({
    deviceModel: 'tobii-pro-fusion',
    sdkName: 'tobii-pro-sdk',
    sdkVersion: '4.1.0',
    platform: 'macos',
    osVersion: '13.6',
    architecture: 'arm64',
  }),
]);

const SUPPORTED_DEVICE_MODELS: readonly string[] = ['tobii-pro-fusion'];
const SUPPORTED_PLATFORM_ARCHITECTURES: readonly string[] = ['macos/arm64'];
const SUPPORTED_SDK_BUILDS: readonly string[] = ['tobii-pro-sdk@4.1.0'];
const SUPPORTED_OS_VERSIONS: readonly string[] = ['14.5', '13.6'];

export function sameCombination(left: DeviceCombination, right: DeviceCombination): boolean {
  return left.deviceModel === right.deviceModel
    && left.sdkName === right.sdkName
    && left.sdkVersion === right.sdkVersion
    && left.platform === right.platform
    && left.osVersion === right.osVersion
    && left.architecture === right.architecture;
}

/**
 * The exact reason a combination is not part of the tested matrix, in the order the qualification
 * reads it: the device model first, then the platform/architecture pair, then the SDK build, then
 * the OS version.
 */
export function combinationRejection(combination: DeviceCombination): string | null {
  if (!SUPPORTED_DEVICE_MODELS.includes(combination.deviceModel)) return 'unsupported_device_model';
  if (!SUPPORTED_PLATFORM_ARCHITECTURES.includes(`${combination.platform}/${combination.architecture}`)) {
    return 'unsupported_platform';
  }
  if (!SUPPORTED_SDK_BUILDS.includes(`${combination.sdkName}@${combination.sdkVersion}`)) {
    return 'unsupported_sdk_version';
  }
  if (!SUPPORTED_OS_VERSIONS.includes(combination.osVersion)) return 'unsupported_os_version';
  return null;
}

export function isTestedCombination(combination: DeviceCombination): boolean {
  return TESTED_SUPPORT_MATRIX.some((entry) => sameCombination(entry, combination));
}

/** Normalized `[0,1]` device gaze → desktop logical points under the live display transform. */
export function mapProbeToDesktopPoints(
  display: DisplayTransform,
  probe: Readonly<{ gazeX: number; gazeY: number }>,
): Readonly<{ meanX: number; meanY: number }> | null {
  const meanX = display.originX + probe.gazeX * display.width;
  const meanY = display.originY + probe.gazeY * display.height;
  if (!Number.isFinite(meanX) || !Number.isFinite(meanY)) return null;
  return { meanX, meanY };
}

function combinationCheck(combination: DeviceCombination): DeviceQualificationCheck {
  const rejection = combinationRejection(combination);
  if (rejection !== null || !isTestedCombination(combination)) {
    const reason = rejection ?? 'unsupported_combination';
    return {
      checkId: 'combination_support',
      status: 'failed',
      detail: `${combination.deviceModel} on ${combination.platform}/${combination.architecture} with `
        + `${combination.sdkName} ${combination.sdkVersion} on OS ${combination.osVersion} is not in the `
        + `qualified support matrix: ${reason}`,
    };
  }
  return {
    checkId: 'combination_support',
    status: 'passed',
    detail: `${combination.deviceModel} on ${combination.platform}/${combination.architecture} with `
      + `${combination.sdkName} ${combination.sdkVersion} on OS ${combination.osVersion} is in the `
      + 'qualified support matrix',
  };
}

type Handshake = Readonly<{ check: DeviceQualificationCheck; reason: string | null }>;

async function handshakeCheck(combination: DeviceCombination, bridge: DeviceBridge): Promise<Handshake> {
  try {
    const connection = await bridge.connect();
    if (connection.connected === true) {
      return {
        check: {
          checkId: 'handshake',
          status: 'passed',
          detail: `the live bridge completed the handshake for ${combination.deviceModel}`,
        },
        reason: null,
      };
    }
    const refusal = typeof connection.reason === 'string' && connection.reason.length > 0
      ? connection.reason
      : 'device_unavailable';
    return {
      check: {
        checkId: 'handshake',
        status: 'failed',
        detail: `the bridge refused the connection: ${refusal}`,
      },
      reason: refusal,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      check: {
        checkId: 'handshake',
        status: 'failed',
        detail: `the bridge threw instead of reporting a value: ${detail}`,
      },
      reason: 'device_unavailable',
    };
  }
}

export async function qualifyDeviceCombination(input: Readonly<{
  combination: DeviceCombination;
  bridge: DeviceBridge;
  display: DisplayTransform;
  probe: Readonly<{ gazeX: number; gazeY: number }>;
}>): Promise<DeviceQualification> {
  const { combination, bridge, display, probe } = input;
  const support = combinationCheck(combination);
  const handshake = await handshakeCheck(combination, bridge);
  const mapped = mapProbeToDesktopPoints(display, probe);
  const mapping: DeviceQualificationCheck = mapped === null
    ? {
      checkId: 'schema_mapping',
      status: 'failed',
      detail: `the probe (${probe.gazeX}, ${probe.gazeY}) could not be mapped into desktop logical points`,
    }
    : {
      checkId: 'schema_mapping',
      status: 'passed',
      detail: `the probe (${probe.gazeX}, ${probe.gazeY}) maps to (${mapped.meanX}, ${mapped.meanY}) `
        + `desktop logical points on ${display.displayId}`,
    };
  const checks: readonly DeviceQualificationCheck[] = [support, handshake.check, mapping];

  const supportReason = support.status === 'failed'
    ? combinationRejection(combination) ?? 'unsupported_combination'
    : null;
  const reason = supportReason ?? handshake.reason ?? (mapping.status === 'failed' ? 'schema_mapping_failed' : null);
  const supported = support.status === 'passed' && handshake.check.status === 'passed' && mapping.status === 'passed';
  const echoed: DeviceCombination = { ...combination };
  return reason === null
    ? { combination: echoed, supported, checks, probe: mapped }
    : { combination: echoed, supported, reason, checks, probe: mapped };
}

/** The published support list: exactly the combinations this suite qualified. */
export function listSupportedDeviceCombinations(): readonly DeviceCombination[] {
  return TESTED_SUPPORT_MATRIX.map((entry) => ({ ...entry }));
}
