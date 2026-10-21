/**
 * 优选结果回传：把 Top N 结果 POST 回面板写入 KV
 */

export interface CallbackResult {
  ok: boolean
  status?: number
  error?: string
}

export async function postResults(
  callbackUrl: string,
  token: string,
  entries: string[],
  timeoutMs = 15000
): Promise<CallbackResult> {
  try {
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'CFPilot-Scanner/1.0',
      },
      body: JSON.stringify({ ips: entries }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { ok: false, status: response.status, error: `回传失败 HTTP ${response.status} ${text}`.trim() }
    }
    return { ok: true, status: response.status }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
