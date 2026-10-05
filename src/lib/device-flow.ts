// RFC 8628 device-authorization login against the Orca server, the CLI's
// only login.
//
// The CLI asks the server for a device_code (its private poll secret) plus a
// short user_code, prints the code and the dashboard URL for the user to open
// on ANY device, then polls until the user approves or denies there. On the
// first poll after approval the server mints the API key with the approver's
// role and returns it once; no secret is stored anywhere before that.
//
// Wire notes: requests are JSON (not form-encoded); flow errors come back
// as HTTP 400 with the RFC-named codes in {"error": "<code>"}.
import { CliError, ExitCode } from './errors.js'

export type DeviceCodeResponse = {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

export type DeviceTokenSuccess = {
  access_token: string
  token_type: string
  key_id: string
  role: string
  tenant_id: string
}

const REQUEST_TIMEOUT_MS = 30_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function postJson(
  url: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new CliError(`request to ${url} timed out`, ExitCode.Failure)
    }
    throw new CliError(`cannot reach ${url}`, ExitCode.Failure, [
      'Check the API URL and your connection.',
    ])
  }
  let json: unknown
  try {
    json = await res.json()
  } catch {
    json = undefined
  }
  return { status: res.status, json }
}

// requestDeviceCode starts the handshake. 404 means the server predates
// device login, and 429 means this address started too many logins; both get
// an actionable message instead of a bare status line.
export async function requestDeviceCode(
  apiUrl: string,
  clientLabel: string,
): Promise<DeviceCodeResponse> {
  const { status, json } = await postJson(`${apiUrl}/api/device/code`, {
    client_label: clientLabel,
  })
  if (status === 404) {
    throw new CliError('this server does not support device login', ExitCode.Failure, [
      'Check the API URL, or pass --with-token <key> with a key minted in the dashboard.',
    ])
  }
  if (status === 429) {
    throw new CliError('too many login attempts from this address', ExitCode.Failure, [
      'Wait a minute, then run: orca auth login',
    ])
  }
  if (status !== 200 || !json || typeof json !== 'object') {
    throw new CliError(`device code request failed (${status})`, ExitCode.Failure)
  }
  const out = json as DeviceCodeResponse
  if (!out.device_code || !out.user_code || !out.verification_uri_complete) {
    throw new CliError('malformed device code response from the server', ExitCode.Failure)
  }
  return out
}

// pollDeviceToken polls until the user decides or the handshake expires.
// Follows RFC 8628 section 3.5: sleep `interval` seconds between polls and
// add 5 seconds whenever the server answers slow_down.
export async function pollDeviceToken(
  apiUrl: string,
  grant: DeviceCodeResponse,
): Promise<DeviceTokenSuccess> {
  let intervalSec = Math.max(1, grant.interval || 5)
  const deadline = Date.now() + Math.max(30, grant.expires_in || 900) * 1000

  for (;;) {
    await sleep(intervalSec * 1000)
    if (Date.now() > deadline) {
      throw new CliError('login timed out waiting for approval', ExitCode.Failure, [
        'Re-run: orca auth login',
      ])
    }
    const { status, json } = await postJson(`${apiUrl}/api/device/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: grant.device_code,
    })
    if (status === 200 && json && typeof json === 'object') {
      const tok = json as DeviceTokenSuccess
      if (!tok.access_token) {
        throw new CliError('malformed token response from the server', ExitCode.Failure)
      }
      return tok
    }
    const code = (json as { error?: string } | undefined)?.error
    switch (code) {
      case 'authorization_pending':
        continue
      case 'slow_down':
        intervalSec += 5
        continue
      case 'access_denied':
        throw new CliError('login denied in the dashboard', ExitCode.Auth)
      case 'expired_token':
        throw new CliError('login code expired', ExitCode.Failure, ['Re-run: orca auth login'])
      case 'invalid_grant':
        throw new CliError('login code was already used or is unknown', ExitCode.Failure, [
          'Re-run: orca auth login',
        ])
      default:
        throw new CliError(`device token poll failed (${status})`, ExitCode.Failure)
    }
  }
}
