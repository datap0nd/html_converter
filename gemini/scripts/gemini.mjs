import { spawn, spawnSync } from 'node:child_process';

function invocation(args, options = {}) {
  const childEnv = { ...process.env, NO_COLOR: '1', ...options.env };
  for (const key of Object.keys(childEnv)) if (/^PG_(?:PASSWORD|USER|HOST|DATABASE|SSL_CA_FILE)$/.test(key)) delete childEnv[key];
  const common = {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeout ?? 20 * 60 * 1000,
    maxBuffer: 50 * 1024 * 1024,
    env: childEnv
  };
  if (process.platform !== 'win32') return { command: 'gemini', args, common };
  // npm installs Gemini CLI as gemini.cmd on Windows. Invoke cmd explicitly;
  // Node 22+/24 deprecates passing an args array with shell:true.
  const encoded = args.map(value => {
    if (/["%!&|<>()^\r\n]/.test(value)) throw new Error('Unsafe Gemini launcher argument');
    return /^[A-Za-z0-9._/-]+$/.test(value) ? value : `"${value}"`;
  });
  const command = ['gemini', ...encoded].join(' ');
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command], common };
}

export function runGemini(args, options = {}) {
  const call = invocation(args, options);
  return spawnSync(call.command, call.args, call.common);
}

export function runGeminiAsync(args, options = {}) {
  const call = invocation(args, options);
  return new Promise(resolve => {
    const child = spawn(call.command, call.args, { ...call.common, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', error = null, timedOut = false;
    const append = (current, chunk, limit) => (current + chunk.toString()).slice(-limit);
    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk, 50 * 1024 * 1024); });
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk, 10 * 1024 * 1024); });
    child.on('error', value => { error = value; });
    const started = Date.now();
    const heartbeat = setInterval(() => options.onHeartbeat?.(`Gemini phase still running (${Math.round((Date.now() - started) / 1000)}s).`), 30000);
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, call.common.timeout);
    child.on('close', status => {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      if (timedOut) error = new Error('Gemini phase timed out after 20 minutes.');
      resolve({ status, stdout, stderr, error });
    });
  });
}
