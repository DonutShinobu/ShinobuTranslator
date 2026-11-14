export function patchFirefoxProgramManager(source: string): string;
export function directReadTransform(source: string): {
  code: string;
  changed: boolean;
  reason?: string;
  kind?: string;
};
