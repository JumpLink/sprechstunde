import { api, message } from './api';
import type { AdminState, CharactersView, Profiles, VoiceSpec } from './types';

/** What every page shows part of: the settings, the environment's voice, the profile list. */
export const app = $state<{
  state?: AdminState;
  profiles?: Profiles;
  characters?: CharactersView;
  casting?: VoiceSpec;
  error?: string;
  loading: boolean;
}>({
  loading: true,
});

export async function reload(): Promise<void> {
  try {
    const [state, profiles, characters] = await Promise.all([
      api<AdminState>('GET', '/api/state'),
      api<Profiles>('GET', '/api/profiles'),
      api<CharactersView>('GET', '/api/characters'),
    ]);
    app.state = state;
    app.profiles = profiles;
    app.characters = characters;
    app.error = undefined;
  } catch (error) {
    app.error = message(error);
  } finally {
    app.loading = false;
  }
}
