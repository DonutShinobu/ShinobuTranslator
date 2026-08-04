export type ContinuousCameraRoundState =
  | { status: 'ready' }
  | {
      status: 'preparing' | 'translating';
      originalUrl: string;
      detail: string;
    }
  | {
      status: 'done';
      originalUrl: string;
      resultUrl: string;
    }
  | {
      status: 'error';
      originalUrl?: string;
      error: string;
    };
