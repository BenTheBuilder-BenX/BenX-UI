import { api } from './api';
/** Complete cookie migration before navigating from a public entry to a private workspace. */
export async function signInToWorkspace(username: string, password: string): Promise<string> {
  const login = await api<{ entryPath: string }>('/login', 'POST', { username, password });
  const session = await api<{ authenticated: boolean; entryPath: string | null }>('/session');
  if (!session.authenticated || session.entryPath !== login.entryPath) throw new Error('Your sign-in session could not be verified. Please try again.');
  return login.entryPath;
}
