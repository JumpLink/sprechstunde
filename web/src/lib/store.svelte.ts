import { api, message } from './api';
import type { AdminState, Profiles } from './types';

/** What every page shows part of: the settings, the environment's voice, the profile list. */
export const app = $state<{ state?: AdminState; profiles?: Profiles; error?: string; loading: boolean }>({
  loading: true,
});

export async function reload(): Promise<void> {
  try {
    const [state, profiles] = await Promise.all([
      api<AdminState>('GET', '/api/state'),
      api<Profiles>('GET', '/api/profiles'),
    ]);
    app.state = state;
    app.profiles = profiles;
    app.error = undefined;
  } catch (error) {
    app.error = message(error);
  } finally {
    app.loading = false;
  }
}
