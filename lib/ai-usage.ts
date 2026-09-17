import { serviceValue } from "./service-vault.ts";
type ProviderUsage = { provider: "OpenAI" | "DeepSeek" | "xAI"; configured: boolean; detailAvailable: boolean; primary: string; secondary: string; tone: "green" | "blue" | "amber" | "muted" };

async function safeJson(url: string, token: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers || {}) }, signal: AbortSignal.timeout(12000), cache: "no-store" });
  if (!response.ok) throw new Error(`USAGE_REQUEST_${response.status}`);
  return response.json();
}

function monthStartUnix() {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
}

function numberFrom(value: unknown) { const result = Number(value); return Number.isFinite(result) ? result : 0; }

export async function getAiUsage(): Promise<{ providers: ProviderUsage[]; updatedAt: string }> {
  const providers: ProviderUsage[] = [];
  if (serviceValue("OPENAI_ADMIN_KEY")) {
    try {
      const [usage, costs] = await Promise.all([
        safeJson(`https://api.openai.com/v1/organization/usage/completions?start_time=${monthStartUnix()}&bucket_width=1d&limit=31`, serviceValue("OPENAI_ADMIN_KEY")),
        safeJson(`https://api.openai.com/v1/organization/costs?start_time=${monthStartUnix()}&bucket_width=1d&limit=31`, serviceValue("OPENAI_ADMIN_KEY")),
      ]);
      const results = (usage.data || []).flatMap((bucket: any) => bucket.results || []);
      const costResults = (costs.data || []).flatMap((bucket: any) => bucket.results || []);
      const tokens = results.reduce((sum: number, item: any) => sum + numberFrom(item.input_tokens) + numberFrom(item.output_tokens), 0);
      const amount = costResults.reduce((sum: number, item: any) => sum + numberFrom(item.amount?.value), 0);
      providers.push({ provider: "OpenAI", configured: true, detailAvailable: true, primary: `$${amount.toFixed(2)}`, secondary: `本月 ${tokens.toLocaleString("zh-CN")} tokens`, tone: "green" });
    } catch { providers.push({ provider: "OpenAI", configured: true, detailAvailable: false, primary: "读取失败", secondary: "Admin Key 权限或网络异常", tone: "amber" }); }
  } else providers.push({ provider: "OpenAI", configured: Boolean(serviceValue("OPENAI_API_KEY")), detailAvailable: false, primary: serviceValue("OPENAI_API_KEY") ? "API 已连接" : "尚未配置", secondary: serviceValue("OPENAI_API_KEY") ? "详细用量需要 Admin Key" : "在服务器端添加 API Key", tone: serviceValue("OPENAI_API_KEY") ? "blue" : "muted" });

  if (serviceValue("DEEPSEEK_API_KEY")) {
    try {
      const balance = await safeJson("https://api.deepseek.com/user/balance", serviceValue("DEEPSEEK_API_KEY"));
      const values = Array.isArray(balance.balance_infos) ? balance.balance_infos : [];
      providers.push({ provider: "DeepSeek", configured: true, detailAvailable: true, primary: values.length ? values.map((item: any) => `${item.currency} ${item.total_balance}`).join(" · ") : "余额未知", secondary: balance.is_available ? "账户可用" : "余额不足或不可用", tone: balance.is_available ? "green" : "amber" });
    } catch { providers.push({ provider: "DeepSeek", configured: true, detailAvailable: false, primary: "读取失败", secondary: "请检查服务器端 API Key", tone: "amber" }); }
  } else providers.push({ provider: "DeepSeek", configured: false, detailAvailable: false, primary: "尚未配置", secondary: "添加 DeepSeek API Key 后显示余额", tone: "muted" });

  if (serviceValue("XAI_MANAGEMENT_KEY") && serviceValue("XAI_TEAM_ID")) {
    try {
      const balance = await safeJson(`https://management-api.x.ai/v1/billing/teams/${encodeURIComponent(serviceValue("XAI_TEAM_ID"))}/prepaid/balance`, serviceValue("XAI_MANAGEMENT_KEY"));
      const cents = numberFrom(balance.total?.val ?? balance.total);
      providers.push({ provider: "xAI", configured: true, detailAvailable: true, primary: `$${(cents / 100).toFixed(2)}`, secondary: "预付余额", tone: "green" });
    } catch { providers.push({ provider: "xAI", configured: true, detailAvailable: false, primary: "读取失败", secondary: "请检查 Management Key 与 Team ID", tone: "amber" }); }
  } else providers.push({ provider: "xAI", configured: Boolean(serviceValue("XAI_API_KEY")), detailAvailable: false, primary: serviceValue("XAI_API_KEY") ? "API 已连接" : "尚未配置", secondary: serviceValue("XAI_API_KEY") ? "完整用量需要 Management Key" : "在服务器端添加 API Key", tone: serviceValue("XAI_API_KEY") ? "blue" : "muted" });
  return { providers, updatedAt: new Date().toISOString() };
}
