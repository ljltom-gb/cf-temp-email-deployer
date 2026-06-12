'use strict';

/**
 * Cloudflare REST API 客户端 - 使用 Global API Key 认证
 *
 * 认证头:
 *   X-Auth-Email: <用户邮箱>
 *   X-Auth-Key:   <Global API Key>
 *
 * 文档: https://developers.cloudflare.com/api/
 */

const API_BASE = 'https://api.cloudflare.com/client/v4';

class CloudflareApiError extends Error {
  constructor(message, status, errors) {
    super(message);
    this.name = 'CloudflareApiError';
    this.status = status;
    this.errors = errors || [];
  }
}

function isInvalidListOptionsError(err) {
  return (
    err instanceof CloudflareApiError &&
    err.errors.some((item) => item.code === 8000024)
  );
}

function createClient({ email, apiKey }) {
  if (!email || !apiKey) {
    throw new Error('CF API 客户端需要 email 与 apiKey');
  }

  const baseHeaders = {
    'X-Auth-Email': email,
    'X-Auth-Key': apiKey,
    'Content-Type': 'application/json',
  };

  async function requestJson(method, path, body) {
    const url = `${API_BASE}${path}`;
    const init = {
      method,
      headers: baseHeaders,
    };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const res = await fetch(url, init);
    let json;
    try {
      json = await res.json();
    } catch {
      throw new CloudflareApiError(
        `CF API 返回非 JSON 内容 (HTTP ${res.status})`,
        res.status,
        []
      );
    }

    if (!res.ok || json.success === false) {
      const errs = Array.isArray(json.errors) ? json.errors : [];
      const summary = errs.length
        ? errs.map((e) => `[${e.code}] ${e.message}`).join('; ')
        : `HTTP ${res.status}`;
      throw new CloudflareApiError(
        `CF API 调用失败 ${method} ${path}: ${summary}`,
        res.status,
        errs
      );
    }
    return json;
  }

  async function request(method, path, body) {
    const json = await requestJson(method, path, body);
    return json.result;
  }

  return {
    /**
     * 校验凭据 - 通过 /user 接口
     */
    async verifyCredentials() {
      return request('GET', '/user');
    },

    /**
     * 获取所有可访问的账户(用户可能属于多个账户)
     */
    async listAccounts() {
      return request('GET', '/accounts');
    },

    async listWorkerScripts(accountId) {
      return request('GET', `/accounts/${accountId}/workers/scripts`);
    },

    async listPagesProjects(accountId) {
      const projects = [];
      const firstPage = await requestJson(
        'GET',
        `/accounts/${accountId}/pages/projects`
      );
      if (Array.isArray(firstPage.result)) {
        projects.push(...firstPage.result);
      }

      const totalPages = firstPage.result_info?.total_pages || 1;
      for (let page = 2; page <= totalPages; page += 1) {
        let json;
        try {
          json = await requestJson(
            'GET',
            `/accounts/${accountId}/pages/projects?page=${page}`
          );
        } catch (err) {
          if (isInvalidListOptionsError(err)) {
            return projects;
          }
          throw err;
        }
        if (Array.isArray(json.result)) {
          projects.push(...json.result);
        }
      }
      return projects;
    },

    async listKvNamespaces(accountId) {
      return request('GET', `/accounts/${accountId}/storage/kv/namespaces?per_page=1000`);
    },

    /**
     * 通过域名查找 zone(返回精确匹配的 zone 对象, 找不到返回 null)
     */
    async findZoneByName(domain) {
      const result = await request(
        'GET',
        `/zones?name=${encodeURIComponent(domain)}`
      );
      if (!Array.isArray(result) || result.length === 0) return null;
      return result[0];
    },

    /**
     * 启用 Email Routing 并下发 DNS 记录
     * 步骤参考: PUT /zones/{zone_id}/email/routing/enable
     *           POST /zones/{zone_id}/email/routing/dns
     */
    async enableEmailRouting(zoneId, subdomain) {
      try {
        await request('POST', `/zones/${zoneId}/email/routing/enable`);
      } catch (err) {
        if (err.status !== 409 && err.status !== 400) {
          throw err;
        }
      }
      try {
        await request(
          'POST',
          `/zones/${zoneId}/email/routing/dns`,
          subdomain ? { name: subdomain } : undefined
        );
      } catch (err) {
        if (err.status !== 409 && err.status !== 400) {
          throw err;
        }
      }
      return request('GET', `/zones/${zoneId}/email/routing`);
    },

    /**
     * 获取 catch-all 规则当前配置
     */
    async getCatchAllRule(zoneId) {
      return request('GET', `/zones/${zoneId}/email/routing/rules/catch_all`);
    },

    /**
     * 把域名的 catch-all 路由到指定 worker
     */
    async setCatchAllToWorker(zoneId, workerName) {
      const body = {
        name: 'cf-temp-email-catch-all',
        enabled: true,
        matchers: [{ type: 'all' }],
        actions: [{ type: 'worker', value: [workerName] }],
      };
      return request('PUT', `/zones/${zoneId}/email/routing/rules/catch_all`, body);
    },

    /**
     * 获取已添加的目的地址(用于 forward action,本项目不强依赖)
     */
    async listDestinationAddresses(accountId) {
      return request('GET', `/accounts/${accountId}/email/routing/addresses`);
    },
  };
}

module.exports = { createClient, CloudflareApiError };
