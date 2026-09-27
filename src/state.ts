export const state = {
  publicUrl: null as string | null,
  tunnelMode: null as string | null,
};

export function setPublicUrl(url: string | null, mode: string | null = null): void {
  state.publicUrl = url;
  state.tunnelMode = mode;
}
