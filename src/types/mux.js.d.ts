declare module 'mux.js' {
  export namespace mp4 {
    class Transmuxer {
      constructor(options?: { remux?: boolean; keepOriginalTimestamps?: boolean });
      on(event: 'data', callback: (segment: { initSegment: Uint8Array; data: Uint8Array }) => void): void;
      on(event: 'done', callback: () => void): void;
      off(event: 'data', callback: Function): void;
      off(event: 'done', callback: Function): void;
      push(data: Uint8Array): void;
      flush(): void;
      reset(): void;
    }
  }
}
