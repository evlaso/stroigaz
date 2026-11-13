declare module 'occt-import-js' {
  interface Occt {
    HEAPU8: Uint8Array;
    ReadStepFile(buffer: Uint8Array, params: Record<string, unknown>): import('./types.ts').OcctResult;
  }
  export default function init(options: {
    locateFile(path: string): string;
    print(text: string): void;
    printErr(text: string): void;
    onAbort(reason: string): void;
  }): Promise<Occt>;
}
