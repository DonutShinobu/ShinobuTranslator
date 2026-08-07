export type ContinuousTabStateCommand =
  | { operation: 'read' }
  | { operation: 'write'; enabled: boolean };

export type ContinuousTabStateResult = { enabled: boolean };
