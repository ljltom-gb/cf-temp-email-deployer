'use strict';

/**
 * wrangler CLI 包装器 - 通过 npx 调用,无需全局安装
 *
 * 认证策略: 使用 Global API Key 时设置环境变量
 *   CLOUDFLARE_EMAIL = <用户邮箱>
 *   CLOUDFLARE_API_KEY = <Global API Key>
 *
 * 关键命令:
 *   wrangler d1 create <name>                          创建 D1
 *   wrangler d1 execute <name> --file=... --remote     执行 SQL
 *   wrangler kv namespace create <binding>             创建 KV
 *   wrangler deploy                                    部署 Worker
 *   wrangler pages deploy <dist> --project-name=<n>    部署 Pages
 *   wrangler pages project create <n> --production-branch=production --compatibility-date=...
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

/**
 * 在 cwd 下执行 wrangler 子命令
 *
 * @param {string[]} args - wrangler 参数(不含 wrangler 本身)
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.email
 * @param {string} opts.apiKey
 * @param {string} [opts.accountId]
 * @param {(line:string,stream:'stdout'|'stderr')=>void} [opts.onLine]
 * @param {string} [opts.input] - 通过 stdin 写入(用于自动应答 wrangler 交互式问题)
 * @returns {Promise<{stdout:string, stderr:string, code:number}>}
 */
function runWrangler(args, opts) {
  const { cwd, email, apiKey, accountId, onLine, input } = opts;
  const env = {
    ...process.env,
    CLOUDFLARE_EMAIL: email,
    CLOUDFLARE_API_KEY: apiKey,
    // 关闭 wrangler 的更新提示与遥测,避免污染输出
    WRANGLER_SEND_METRICS: 'false',
    NO_UPDATE_NOTIFIER: '1',
    CI: 'true',
    FORCE_COLOR: '0',
  };
  if (accountId) {
    env.CLOUDFLARE_ACCOUNT_ID = accountId;
  }

  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'npx.cmd' : 'npx';
    const child = spawn(cmd, ['--yes', 'wrangler@latest', ...args], {
      cwd,
      env,
      shell: isWin,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const startTs = Date.now();
    let lastTs = Date.now();

    // 静默心跳：每 20s 检查一次,若 ≥15s 无输出则发一行状态,避免 SSE 端看着卡死
    const tick = setInterval(() => {
      const now = Date.now();
      const silent = Math.floor((now - lastTs) / 1000);
      const elapsed = Math.floor((now - startTs) / 1000);
      if (silent >= 15 && onLine) {
        onLine(
          `(仍在运行 wrangler ${args.join(' ')}, 已耗时 ${elapsed}s, 静默 ${silent}s)`,
          'stdout',
        );
      }
    }, 20000);

    function pipe(stream, name) {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        lastTs = Date.now();
        if (name === 'stdout') stdout += chunk;
        else stderr += chunk;
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (onLine) onLine(line, name);
        }
      });
      stream.on('end', () => {
        if (buffer && onLine) onLine(buffer, name);
      });
    }

    pipe(child.stdout, 'stdout');
    pipe(child.stderr, 'stderr');

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();

    child.on('error', (err) => {
      clearInterval(tick);
      reject(err);
    });
    child.on('close', (code) => {
      clearInterval(tick);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

async function runOrThrow(args, opts) {
  const result = await runWrangler(args, opts);
  if (result.code !== 0) {
    const tail = (result.stderr || result.stdout).trim().split('\n').slice(-20).join('\n');
    const err = new Error(`wrangler ${args.join(' ')} 失败 (退出码 ${result.code}):\n${tail}`);
    err.result = result;
    throw err;
  }
  return result;
}

/**
 * 创建 D1 数据库,返回 database_id
 * wrangler 输出包含一段 toml 片段,我们用正则解析 database_id = "..."
 */
async function createD1(dbName, opts) {
  const result = await runOrThrow(['d1', 'create', dbName], opts);
  const text = result.stdout + '\n' + result.stderr;
  const m =
    text.match(/"database_id"\s*:\s*"([0-9a-f-]+)"/i) ||
    text.match(/database_id\s*=\s*"([0-9a-f-]+)"/i);
  if (!m) {
    throw new Error(`无法从 wrangler 输出解析 D1 database_id:\n${text}`);
  }
  return m[1];
}

/**
 * 通过 d1 list 查询已存在的数据库 ID(用于幂等)
 */
async function findD1ByName(dbName, opts) {
  const result = await runWrangler(['d1', 'list', '--json'], opts);
  if (result.code !== 0) return null;
  try {
    // wrangler 在 stdout 输出 JSON 数组
    // 兼容前面可能有非 JSON 行
    const jsonStart = result.stdout.indexOf('[');
    const jsonEnd = result.stdout.lastIndexOf(']');
    if (jsonStart === -1 || jsonEnd === -1) return null;
    const arr = JSON.parse(result.stdout.slice(jsonStart, jsonEnd + 1));
    const hit = arr.find((db) => db.name === dbName || db.database_name === dbName);
    return hit ? hit.uuid || hit.database_id || hit.id : null;
  } catch {
    return null;
  }
}

/**
 * 在指定 D1 上远程执行 SQL 文件
 */
async function executeD1File(dbName, sqlFile, opts) {
  return runOrThrow(
    ['d1', 'execute', dbName, '--file', sqlFile, '--remote', '--yes'],
    opts
  );
}

/**
 * 创建 KV namespace,返回 id
 */
async function createKvNamespace(binding, opts) {
  const result = await runOrThrow(['kv', 'namespace', 'create', binding], opts);
  const text = result.stdout + '\n' + result.stderr;
  const m =
    text.match(/"id"\s*:\s*"([a-f0-9]+)"/i) ||
    text.match(/\bid\s*=\s*"([a-f0-9]+)"/i);
  if (!m) throw new Error(`无法从 wrangler 输出解析 KV id:\n${text}`);
  return m[1];
}

/**
 * 部署 Worker(在指定 cwd,需提前写好 wrangler.toml)
 * 解析输出抓取 worker URL
 */
async function deployWorker(opts) {
  const result = await runOrThrow(['deploy'], opts);
  const text = result.stdout + '\n' + result.stderr;
  // 匹配类似 https://xxx.xxx.workers.dev
  const m = text.match(/https?:\/\/[^\s]+\.workers\.dev/);
  return {
    url: m ? m[0] : null,
    raw: text,
  };
}

/**
 * 创建 Pages 项目(若不存在则创建,存在则忽略错误)
 */
async function ensurePagesProject(projectName, opts) {
  const result = await runWrangler(
    [
      'pages',
      'project',
      'create',
      projectName,
      '--production-branch=production',
    ],
    opts
  );
  // 已存在时 wrangler 返回非 0,但消息含 "already exists" - 视为成功
  if (result.code !== 0) {
    const combined = result.stdout + result.stderr;
    if (!/already exists|已存在/i.test(combined)) {
      throw new Error(`创建 Pages 项目失败:\n${combined.trim().split('\n').slice(-10).join('\n')}`);
    }
  }
  return projectName;
}

/**
 * 部署 Pages 静态资源
 */
async function deployPages(projectName, distDir, opts) {
  const result = await runOrThrow(
    [
      'pages',
      'deploy',
      distDir,
      `--project-name=${projectName}`,
      '--branch=production',
      '--commit-dirty=true',
    ],
    opts
  );
  const text = result.stdout + '\n' + result.stderr;
  const m = text.match(/https?:\/\/[a-z0-9-]+\.pages\.dev/);
  return {
    url: m ? m[0] : null,
    raw: text,
  };
}

module.exports = {
  runWrangler,
  runOrThrow,
  createD1,
  findD1ByName,
  executeD1File,
  createKvNamespace,
  deployWorker,
  ensurePagesProject,
  deployPages,
};
