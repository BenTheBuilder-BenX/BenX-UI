export interface SSHSetup { host: string; port: number; username: string; authentication: 'password' | 'key'; keyPath: string }
export function validateSSHSetup(value: SSHSetup) {
  if (!value.host || value.host.length > 253 || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(value.host) || !/^[a-z_][a-z0-9_-]{0,31}$/.test(value.username) || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !['password', 'key'].includes(value.authentication)) throw new Error('Enter a valid SSH hostname or IPv4 address, port and Linux username.');
  if (value.authentication === 'key' && (!value.keyPath.trim() || /[\r\n\0]/.test(value.keyPath))) throw new Error('Enter the path to your private key on your computer.');
}
const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const encode = (value: string) => { const bytes = new TextEncoder().encode(value); let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); };
export function sshSetupScript(value: SSHSetup, files: Record<string, string>) {
  validateSSHSetup(value);
  for (const name of Object.keys(files)) if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Invalid agent filename.');
  const stage = `/tmp/benx-setup-${crypto.randomUUID()}`;
  const installer = `#!/bin/sh
set -eu
if [ "$(id -u)" != 0 ]; then echo 'Run setup with root or sudo.' >&2; exit 1; fi
command -v python3 >/dev/null
python3 -c 'import sys; assert sys.version_info >= (3,11), "Python 3.11 or newer is required"'
command -v systemctl >/dev/null
if [ -e /opt/benx-agent/benx_agent.py ]; then echo 'BenX agent already exists. Existing installation was preserved; use its HTTPS endpoint and token.'; exit 0; fi
install -d -m 700 /opt/benx-agent /var/lib/benx-agent
install -m 700 ${stage}/benx_agent.py /opt/benx-agent/benx_agent.py
for name in ${Object.keys(files).filter(name => !['benx_agent.py', 'benx-agent.service'].includes(name)).join(' ')}; do install -m 600 ${stage}/"$name" /opt/benx-agent/; done
install -m 644 ${stage}/benx-agent.service /etc/systemd/system/benx-agent.service
if [ ! -e /etc/benx-agent.env ]; then (umask 077; python3 -c 'import secrets; print("BENX_AGENT_TOKEN="+secrets.token_hex(32))' > /etc/benx-agent.env); fi
chmod 600 /etc/benx-agent.env
systemctl daemon-reload
systemctl enable --now benx-agent
systemctl is-active --quiet benx-agent
echo 'Agent installed on 127.0.0.1:8095. Publish it through HTTPS or Cloudflare Tunnel, then enter its URL and private token in BenX-UI.'
`;
  const packageFiles = { ...files, 'install.sh': installer };
  return `# BenX-UI SSH setup. Review before running in PowerShell.
# Your SSH password/passphrase is requested by OpenSSH locally and is never sent to BenX-UI.
# Check the server host-key fingerprint when SSH asks. Existing known-host checks stay enabled.
$ErrorActionPreference = 'Stop'
if (!(Get-Command ssh -ErrorAction SilentlyContinue) -or !(Get-Command scp -ErrorAction SilentlyContinue)) { throw 'Install the OpenSSH Client on this computer first.' }
$target = ${psQuote(`${value.username}@${value.host}`)}
$sshArgs = @('-p', '${value.port}', '-o', 'StrictHostKeyChecking=ask')
$scpArgs = @('-P', '${value.port}', '-o', 'StrictHostKeyChecking=ask')
${value.authentication === 'key' ? `$sshArgs += @('-i', ${psQuote(value.keyPath)})\n$scpArgs += @('-i', ${psQuote(value.keyPath)})` : ''}
$setupRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('benx-setup-' + [guid]::NewGuid().ToString())
$null = New-Item -ItemType Directory -Path $setupRoot
try {
${Object.entries(packageFiles).map(([name, body]) => `  [System.IO.File]::WriteAllBytes((Join-Path $setupRoot '${name}'), [Convert]::FromBase64String('${encode(body)}'))`).join('\n')}
  & ssh @sshArgs $target ${psQuote(`umask 077; mkdir ${stage}`)}
  if ($LASTEXITCODE -ne 0) { throw 'SSH connection failed. Nothing was installed.' }
  $uploadFiles = @(Get-ChildItem -LiteralPath $setupRoot -File | ForEach-Object { $_.FullName })
  & scp @scpArgs @uploadFiles ($target + ':${stage}/')
  if ($LASTEXITCODE -ne 0) { throw 'Agent upload failed.' }
  & ssh @sshArgs '-t' $target ${psQuote(`${value.username === 'root' ? '' : 'sudo '}sh ${stage}/install.sh`)}
  if ($LASTEXITCODE -ne 0) { throw 'Agent setup failed. Review the SSH output.' }
  & ssh @sshArgs $target ${psQuote(`rm -f ${Object.keys(packageFiles).map(n => `${stage}/${n}`).join(' ')}; rmdir ${stage}`)}
  Write-Host 'Next: expose the loopback agent through HTTPS, retrieve the token privately from /etc/benx-agent.env, then use Test connection in BenX-UI.'
} finally {
  $resolvedSetup = [System.IO.Path]::GetFullPath($setupRoot)
  $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  if (!$resolvedSetup.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -or !(Split-Path $resolvedSetup -Leaf).StartsWith('benx-setup-')) { throw 'Unexpected setup path; cleanup stopped.' }
  Remove-Item -LiteralPath $resolvedSetup -Recurse -Force
}
`;
}
