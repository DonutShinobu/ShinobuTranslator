export class BinbInvalidResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BinbInvalidResponseError';
  }
}

export class BinbUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BinbUnsupportedError';
  }
}
