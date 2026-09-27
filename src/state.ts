export interface DriveState {
  connected: boolean;
  docUrl: string | null;
  lastPollAt: number | null;
  lastError: string | null;
  openQuestions: number;
}

export const state = {
  publicUrl: null as string | null,
  tunnelMode: null as string | null,
  drive: {
    connected: false,
    docUrl: null,
    lastPollAt: null,
    lastError: null,
    openQuestions: 0,
  } as DriveState,
};

export function setPublicUrl(url: string | null, mode: string | null = null): void {
  state.publicUrl = url;
  state.tunnelMode = mode;
}

export function setDrive(patch: Partial<DriveState>): void {
  Object.assign(state.drive, patch);
}
