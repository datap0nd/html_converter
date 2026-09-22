import { spawnSync } from 'node:child_process';

export function runGemini(args, options = {}) {
  const common = {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: 20 * 60 * 1000,
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', ...options.env }
  };
  if (process.platform !== 'win32') return spawnSync('gemini', args, common);
  // npm installs Gemini CLI as gemini.cmd on Windows. Invoke cmd explicitly;
  // Node 22+/24 deprecates passing an args array with shell:true.
  const encoded = args.map(value => {
    if (/["%!&|<>()^\r\n]/.test(value)) throw new Error('Unsafe Gemini launcher argument');
    return /^[A-Za-z0-9._/-]+$/.test(value) ? value : `"${value}"`;
  });
  const command = ['gemini', ...encoded].join(' ');
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], common);
}
