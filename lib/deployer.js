'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const simpleGit = require('simple-git');

const wrangler = require('./wrangler');
const { createClient } = require('./cf-api');

const REPO_URL = 'https://github.com/QLHazyCoder/cloudflare_temp_email.git';
const REPO_BRANCH = 'main';

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function buildWranglerToml({
  workerName,
  domains,
  d1Name,
  d1Id,
  jwtSecret,
  adminPassword,
  kvId,
}) {
  const domainsArr = domains.map((d) => `"${d}"`).join(', ');
  const lines = [
    `name = "${workerName}"`,
    `main = "src/worker.ts"`,
    `compatibility_date = "2024-09-23"`,
    `compatibility_flags = [ "nodejs_compat" ]`,
    ``,
    `[assets]`,
    `directory = "../frontend/dist/"`,
    `binding = "ASSETS"`,
    `run_worker_first = true`,
    ``,
    `[vars]`,
    `PREFIX = "tmp"`,
    `DOMAINS = [${domainsArr}]`,
    `JWT_SECRET = "${jwtSecret}"`,
    `ADMIN_PASSWORDS = ["${adminPassword}"]`,
    `ENABLE_USER_CREATE_EMAIL = true`,
    `ENABLE_USER_DELETE_EMAIL = true`,
    ``,
    `[[d1_databases]]`,
    `binding = "DB"`,
    `database_name = "${d1Name}"`,
    `database_id = "${d1Id}"`,
  ];
  if (kvId) {
    lines.push(
      ``,
      `[[kv_namespaces]]`,
      `binding = "KV"`,
      `id = "${kvId}"`,
    );
  }
  return lines.join('\n') + '\n';
}

function hasResourceName(items, name, keys) {
  if (!Array.isArray(items)) return false;
  return items.some((item) => keys.some((key) => item && item[key] === name));
}

function chooseAvailableName(baseName, isTaken) {
  if (!isTaken(baseName)) return baseName;
  for (let i = 2; i <= 100; i += 1) {
    const candidate = `${baseName}-${i}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error(`无法为 ${baseName} 找到可用名称, 已尝试 -2 到 -100`);
}

function kvNamespaceTitle(workerName) {
  return `${workerName}-DEV`;
}

function logNameChange(log, label, requestedName, finalName) {
  if (requestedName !== finalName) {
    log('warn', `${label} 名称已存在, 改用: ${finalName}`);
  }
}

function normalizeEmailSubdomains(input) {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : String(input).split(/[\s,，;；]+/);
  const seen = new Set();
  const result = [];
  for (const item of raw) {
    const value = String(item || '').trim().replace(/^\.+|\.+$/g, '').toLowerCase();
    if (!value) continue;
    const labels = value.split('.').filter(Boolean);
    if (labels.length < 1 || labels.length > 3) {
      throw new Error(`邮箱子域名 ${value} 必须是 1-3 级, 例如 mail、tmp.mail、dev.tmp.mail`);
    }
    if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error(`邮箱子域名 ${value} 包含非法标签`);
    }
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function expandEmailDomains(domains, subdomains) {
  const seen = new Set();
  const result = [];
  for (const domain of domains) {
    const base = String(domain).trim().toLowerCase();
    if (!base || seen.has(base)) continue;
    seen.add(base);
    result.push({ domain: base, zoneDomain: base, subdomain: null });
    for (const prefix of subdomains) {
      const fullDomain = prefix.endsWith(`.${base}`) ? prefix : `${prefix}.${base}`;
      if (seen.has(fullDomain)) continue;
      seen.add(fullDomain);
      result.push({ domain: fullDomain, zoneDomain: base, subdomain: fullDomain });
    }
  }
  return result;
}

async function ensureRepo(workDir, log) {
  fs.mkdirSync(workDir, { recursive: true });
  const repoDir = path.join(workDir, 'cloudflare_temp_email');
  if (fs.existsSync(path.join(repoDir, '.git'))) {
    log('info', `仓库已存在,执行 git pull 更新: ${repoDir}`);
    const git = simpleGit(repoDir);
    await git.fetch('origin', REPO_BRANCH);
    await git.checkout(REPO_BRANCH);
    await git.pull('origin', REPO_BRANCH);
  } else {
    log('info', `克隆仓库到: ${repoDir}`);
    const git = simpleGit();
    await git.clone(REPO_URL, repoDir, ['--branch', REPO_BRANCH, '--depth', '1']);
  }
  return repoDir;
}

function runPnpm(args, opts) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('node:child_process');
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'npx.cmd' : 'npx';
    const child = spawn(cmd, ['--yes', 'pnpm@10', ...args], {
      cwd: opts.cwd,
      env: { ...process.env, CI: 'true', NO_UPDATE_NOTIFIER: '1' },
      shell: isWin,
      windowsHide: true,
    });
    let lastTs = Date.now();
    function pipe(stream, name) {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        lastTs = Date.now();
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (opts.onLine) opts.onLine(line, name);
        }
      });
      stream.on('end', () => {
        if (buf && opts.onLine) opts.onLine(buf, name);
      });
    }
    pipe(child.stdout, 'stdout');
    pipe(child.stderr, 'stderr');
    const startTs = Date.now();
    const tick = setInterval(() => {
      const idleSec = Math.round((Date.now() - lastTs) / 1000);
      const totalSec = Math.round((Date.now() - startTs) / 1000);
      if (opts.onLine && idleSec >= 15) {
        opts.onLine(`(仍在运行 pnpm ${args.join(' ')}, 已耗时 ${totalSec}s, 静默 ${idleSec}s)`, 'tick');
      }
    }, 20000);
    child.on('error', (err) => {
      clearInterval(tick);
      reject(err);
    });
    child.on('close', (code) => {
      clearInterval(tick);
      if (code === 0) resolve();
      else reject(new Error(`pnpm ${args.join(' ')} 失败 (退出码 ${code})`));
    });
  });
}

async function deploy(config, emit) {
  const log = (level, message, extra) =>
    emit({ type: 'log', level, message, extra: extra ?? null, ts: Date.now() });
  const stage = (id, status, message) =>
    emit({ type: 'stage', id, status, message: message ?? '', ts: Date.now() });

  const {
    email,
    apiKey,
    domains,
    emailSubdomains,
    workerName: requestedWorkerName = 'cloudflare-temp-email',
    pagesProjectName: requestedPagesProjectName = 'cloudflare-temp-email-frontend',
    d1Name: requestedD1Name = 'temp-email-db',
    workDir,
    skipPages = false,
    skipEmailRouting = false,
  } = config;

  if (!email) throw new Error('缺少 Cloudflare 邮箱');
  if (!apiKey) throw new Error('缺少 Global API Key');
  if (!Array.isArray(domains) || domains.length === 0) {
    throw new Error('至少需要一个域名');
  }
  const normalizedDomains = domains.map((domain) => String(domain).trim().toLowerCase()).filter(Boolean);
  if (normalizedDomains.length === 0) {
    throw new Error('至少需要一个有效域名');
  }
  const normalizedEmailSubdomains = normalizeEmailSubdomains(emailSubdomains);
  const emailDomains = expandEmailDomains(normalizedDomains, normalizedEmailSubdomains);

  const cf = createClient({ email, apiKey });
  const wranglerOpts = { email, apiKey };

  stage('verify', 'running', '校验 Cloudflare 凭据...');
  log('info', `登录账号: ${email}`);
  await cf.verifyCredentials();
  const accounts = await cf.listAccounts();
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('该账号下未找到任何 Cloudflare 账户');
  }
  const accountId = accounts[0].id;
  log('info', `使用账户: ${accounts[0].name} (${accountId})`);
  stage('verify', 'done', `账户 ${accounts[0].name}`);

  stage('zones', 'running', '查询域名 zone...');
  const zoneInfo = [];
  for (const domain of normalizedDomains) {
    const zone = await cf.findZoneByName(domain);
    if (!zone) {
      throw new Error(
        `域名 ${domain} 未在 Cloudflare 找到对应 zone, 请先在 CF 控制台添加该域名`
      );
    }
    log('info', `域名 ${domain} -> zone ${zone.id} (status: ${zone.status})`);
    zoneInfo.push({ domain, zoneId: zone.id, status: zone.status });
  }
  stage('zones', 'done', `${zoneInfo.length} 个域名已确认`);

  stage('repo', 'running', '准备仓库源码...');
  const repoDir = await ensureRepo(workDir, log);
  const workerDir = path.join(repoDir, 'worker');
  const frontendDir = path.join(repoDir, 'frontend');
  const dbSchema = path.join(repoDir, 'db', 'schema.sql');
  if (!fs.existsSync(dbSchema)) {
    throw new Error(`仓库中未找到 db/schema.sql: ${dbSchema}`);
  }
  stage('repo', 'done', `源码就绪: ${repoDir}`);

  stage('names', 'running', '检查 Cloudflare 同名资源...');
  const [workers, pagesProjects, kvNamespaces, d1Databases] = await Promise.all([
    cf.listWorkerScripts(accountId),
    skipPages ? Promise.resolve([]) : cf.listPagesProjects(accountId),
    cf.listKvNamespaces(accountId),
    wrangler.listD1Databases({
      ...wranglerOpts,
      cwd: workerDir,
      onLine: (l) => log('debug', `[wrangler] ${l}`),
    }),
  ]);

  const workerName = chooseAvailableName(
    requestedWorkerName,
    (name) =>
      hasResourceName(workers, name, ['id', 'name']) ||
      hasResourceName(kvNamespaces, kvNamespaceTitle(name), ['title', 'name'])
  );
  const pagesProjectName = chooseAvailableName(
    requestedPagesProjectName,
    (name) => hasResourceName(pagesProjects, name, ['name'])
  );
  const d1Name = chooseAvailableName(
    requestedD1Name,
    (name) => hasResourceName(d1Databases, name, ['name', 'database_name'])
  );
  const kvName = kvNamespaceTitle(workerName);

  logNameChange(log, 'Worker/KV', requestedWorkerName, workerName);
  if (!skipPages) {
    logNameChange(log, 'Pages', requestedPagesProjectName, pagesProjectName);
  }
  logNameChange(log, 'D1', requestedD1Name, d1Name);
  if (workerName !== requestedWorkerName) {
    log('warn', `KV namespace 将随 Worker 名称改用: ${kvName}`);
  }
  stage('names', 'done', `Worker=${workerName}, Pages=${skipPages ? '(跳过)' : pagesProjectName}, D1=${d1Name}, KV=${kvName}`);

  stage('d1', 'running', '创建 D1 数据库...');
  const d1Id = await wrangler.createD1(d1Name, {
    ...wranglerOpts,
    accountId,
    cwd: workerDir,
    onLine: (l) => log('debug', `[wrangler] ${l}`),
  });
  log('info', `已创建 D1: ${d1Name} (${d1Id})`);
  stage('d1', 'done', `${d1Name} (${d1Id})`);

  const jwtSecret = randomHex(32);
  const adminPassword = randomHex(8);

  fs.writeFileSync(
    path.join(workerDir, 'wrangler.toml'),
    buildWranglerToml({
      workerName,
      domains: emailDomains.map((item) => item.domain),
      d1Name,
      d1Id,
      jwtSecret,
      adminPassword,
      kvId: null,
    })
  );
  log('info', `已刷新 wrangler.toml 中的 D1 绑定`);

  stage('schema', 'running', '初始化 D1 schema...');
  await wrangler.executeD1File(d1Name, dbSchema, {
    ...wranglerOpts,
    accountId,
    cwd: workerDir,
    onLine: (l) => log('debug', `[d1-exec] ${l}`),
  });
  stage('schema', 'done', 'schema.sql 已应用');

  stage('kv', 'running', '创建 KV namespace...');
  let kvId = null;
  try {
    kvId = await wrangler.createKvNamespace('DEV', {
      ...wranglerOpts,
      accountId,
      cwd: workerDir,
      onLine: (l) => log('debug', `[wrangler] ${l}`),
    });
    log('info', `已创建 KV: ${kvName} (${kvId})`);
    stage('kv', 'done', `${kvName} (${kvId})`);
  } catch (err) {
    log('warn', `创建 KV 失败,跳过(将不绑定 KV): ${err.message}`);
    stage('kv', 'skipped', err.message);
  }

  stage('frontend-build', 'running', '安装并构建前端...');
  await runPnpm(['install', '--no-frozen-lockfile'], {
    cwd: frontendDir,
    onLine: (l) => log('debug', `[pnpm-fe] ${l}`),
  });
  const envProd = `VITE_API_BASE=\n`;
  fs.writeFileSync(path.join(frontendDir, '.env.prod'), envProd);
  await runPnpm(['run', 'build:pages'], {
    cwd: frontendDir,
    onLine: (l) => log('debug', `[pnpm-fe] ${l}`),
  });
  stage('frontend-build', 'done', `frontend/dist 已生成`);

  stage('worker', 'running', '部署 Worker...');
  const tomlBody = buildWranglerToml({
    workerName,
    domains: emailDomains.map((item) => item.domain),
    d1Name,
    d1Id,
    jwtSecret,
    adminPassword,
    kvId,
  });
  fs.writeFileSync(path.join(workerDir, 'wrangler.toml'), tomlBody);
  log('info', `生成 wrangler.toml`);

  await runPnpm(['install', '--no-frozen-lockfile'], {
    cwd: workerDir,
    onLine: (l) => log('debug', `[pnpm-worker] ${l}`),
  });

  const workerResult = await wrangler.deployWorker({
    ...wranglerOpts,
    accountId,
    cwd: workerDir,
    onLine: (l) => log('debug', `[deploy] ${l}`),
  });
  log('info', `Worker URL: ${workerResult.url || '(未解析到 URL)'}`);
  stage('worker', 'done', workerResult.url || workerName);

  let pagesUrl = null;
  if (!skipPages) {
    stage('pages', 'running', '部署 Pages 前端...');
    const apiBase = workerResult.url || '';
    fs.writeFileSync(
      path.join(frontendDir, '.env.prod'),
      `VITE_API_BASE=${apiBase}\n`
    );
    await runPnpm(['run', 'build', '--', '--emptyOutDir'], {
      cwd: frontendDir,
      onLine: (l) => log('debug', `[pnpm-fe2] ${l}`),
    }).catch(async () => {
      await runPnpm(['run', 'build', '--emptyOutDir'], {
        cwd: frontendDir,
        onLine: (l) => log('debug', `[pnpm-fe2] ${l}`),
      });
    });

    await wrangler.ensurePagesProject(pagesProjectName, {
      ...wranglerOpts,
      accountId,
      cwd: frontendDir,
      onLine: (l) => log('debug', `[pages] ${l}`),
    });
    const pagesResult = await wrangler.deployPages(
      pagesProjectName,
      path.join(frontendDir, 'dist'),
      {
        ...wranglerOpts,
        accountId,
        cwd: frontendDir,
        onLine: (l) => log('debug', `[pages] ${l}`),
      }
    );
    pagesUrl = pagesResult.url;
    log('info', `Pages URL: ${pagesUrl || '(未解析到 URL)'}`);
    stage('pages', 'done', pagesUrl || pagesProjectName);
  } else {
    stage('pages', 'skipped', '已跳过 Pages 部署');
  }

  if (!skipEmailRouting) {
    stage('email', 'running', '配置 Email Routing...');
    const zonesByDomain = new Map(zoneInfo.map((zone) => [zone.domain, zone]));
    for (const { domain, zoneDomain, subdomain } of emailDomains) {
      const zone = zonesByDomain.get(zoneDomain);
      if (!zone) throw new Error(`域名 ${domain} 缺少 zone 信息`);
      log('info', `[${domain}] 启用 Email Routing 并下发 DNS`);
      await cf.enableEmailRouting(zone.zoneId, subdomain);
      if (subdomain) {
        log('info', `[${domain}] 已开启子域名 Email Routing`);
      }
    }
    for (const { domain, zoneId } of zoneInfo) {
      log('info', `[${domain}] 设置 Catch-all 路由到 worker ${workerName}`);
      await cf.setCatchAllToWorker(zoneId, workerName);
    }
    stage('email', 'done', `${emailDomains.length} 个邮箱域名已配置`);
  } else {
    stage('email', 'skipped', '已跳过 Email Routing 配置');
  }

  return {
    workerName,
    workerUrl: workerResult.url,
    pagesProjectName,
    pagesUrl,
    d1Name,
    d1Id,
    kvId,
    kvName,
    adminPassword,
    domains: emailDomains.map((item) => item.domain),
    emailSubdomains: normalizedEmailSubdomains,
  };
}

module.exports = { deploy };
