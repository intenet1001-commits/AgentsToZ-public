declare global {
  interface Window {
    __TAURI__?: {
      core?: {
        invoke<T>(command: string, args?: any): Promise<T>;
      };
    };
  }
}

export {};
