export function activationFragment(hash: string): { mode: 'activate' | 'recover'; token: string } | undefined {
  const match = hash.match(/^#(setup|recover)=([a-f0-9]{64})$/);
  return match ? { mode: match[1] === 'recover' ? 'recover' : 'activate', token: match[2] } : undefined;
}
