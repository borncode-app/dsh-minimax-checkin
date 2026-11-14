import z from '@deepseek-ai/schemastery'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Services this plugin waits for before it applies.
 *
 * The status and claim routes are served by the Web GUI's own server, and the
 * check-in tool is registered on the Host tool registry, so neither may be
 * applied before those services exist.
 */
export const inject = ['webServer', 'tools']

/** The MiniMax Code API group that serves the daily check-in. */
export const SIGNIN_PATH = '/minimax-cloud/api/v1/signin'

/**
 * The secret MiniMax Code mixes into its request signature.
 *
 * The desktop client signs every request with
 * `md5(`${second}I*7Cf%WZ#S&%1RlZJ&C2${body}`)` and a second `yy` header that
 * covers the signed path and the request body. Both are reproduced here so the
 * check-in endpoints accept a request that did not come from the app.
 */
export const REQUEST_SIGNATURE_SECRET = 'I*7Cf%WZ#S&%1RlZJ&C2'

/** Day states the MiniMax check-in panel reports. */
export const DayStatus = {
  Upcoming: 1,
  Claimable: 2,
  Claimed: 3,
  Disabled: 4,
}

/** Results a MiniMax check-in claim reports. */
export const ClaimResult = {
  Claimed: 1,
  AlreadyClaimed: 2,
}

/** A sign-in problem that the user can act on. */
export class CheckinUnavailableError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'CheckinUnavailableError'
    this.code = options.code ?? 'MINIMAX_CHECKIN_UNAVAILABLE'
  }
}

export const Config = z.object({
  /** When false the plugin registers no route, tool, or schedule. */
  enabled: z.boolean().default(true),
  /** MiniMax Code home; empty means `$MINIMAX_HOME` or `~/.minimax`. */
  minimaxHome: z.string().default(''),
  /** OAuth build environment directory under the MiniMax home. */
  buildEnv: z.string().default('prod'),
  /** OAuth region directory under the MiniMax home. */
  region: z.string().default('en'),
  /** Origin that serves the MiniMax Code API. */
  apiBaseURL: z.string().default('https://agent.minimax.io'),
  /** OAuth token endpoint; empty derives it from the region. */
  oauthTokenURL: z.string().default(''),
  /** MiniMax Code version reported to the API; the app sends its own version. */
  appVersion: z.string().default('3.1.14'),
  /** Refresh the OAuth token this long before it expires. */
  refreshSkewMs: z.number().default(600000),
  /** Milliseconds one API request may take. */
  timeoutMs: z.number().default(20000),
  /** Same-origin Web GUI path that reports the check-in panel. */
  statusPath: z.string().default('/plugins/minimax-checkin/status'),
  /** Same-origin Web GUI path that claims the daily reward. */
  claimPath: z.string().default('/plugins/minimax-checkin/claim'),
  /** Claim the daily reward on a schedule, without opening MiniMax Code. */
  autoCheckIn: z.boolean().default(false),
  /** Local hour of the day the scheduled check-in runs. */
  autoCheckInHour: z.number().default(9),
})

/** A finite non-negative number, or undefined. */
function numberOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Resolve a possibly wrapped configuration value. */
function readConfig(config, field, fallback) {
  const value = config?.[field]
  if (value === undefined) return fallback
  const resolved = typeof value?.get === 'function' ? value.get() : value
  return resolved === undefined ? fallback : resolved
}

/** The lowercase hex MD5 digest of one string. */
export function md5(value) {
  return createHash('md5').update(value).digest('hex')
}

/** Trim a trailing slash so base URLs concatenate cleanly. */
const withoutSlash = (value) => value.replace(/\/+$/u, '')

/** The OAuth token endpoint for a region. */
export function oauthTokenURLFor(region) {
  const account = region === 'cn' ? 'https://account.minimax.cn' : 'https://account.minimax.io'
  return `${account}/oauth2/token`
}

/** The platform name this machine reports to the API. */
function osName() {
  if (process.platform === 'win32') return 'Windows'
  if (process.platform === 'darwin') return 'macOS'
  if (process.platform === 'linux') return 'Linux'
  return 'unknown'
}

/**
 * One value that survives the Harness's lossless-JSON check.
 *
 * A tool result has to round-trip through JSON without losing anything: an
 * `undefined` property, a non-finite number, or a value that is not a plain
 * object or array is refused, and the tool call fails instead of returning
 * its answer. This drops the properties that are `undefined`, turns
 * `undefined` array entries into `null`, and replaces a number JSON cannot
 * carry with `null`.
 *
 * @param {unknown} value - the value to make safe.
 * @returns {unknown} the value as plain JSON data.
 */
export function jsonSafe(value) {
  if (value === null) return null
  const kind = typeof value
  if (kind === 'boolean' || kind === 'string') return value
  if (kind === 'number') return Number.isFinite(value) ? value : null
  if (kind === 'undefined') return null
  if (Array.isArray(value)) return value.map(item => jsonSafe(item))
  if (kind === 'object') {
    const plain = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      plain[key] = jsonSafe(item)
    }
    return plain
  }
  return null
}

/**
 * A cross-process lock compatible with MiniMax Code's own `auth.lock`.
 *
 * MiniMax Code locks the same file through `proper-lockfile`, which owns the
 * lock by atomically creating `<file>.lock` as a directory and treats a lock
 * idle past its stale window as abandoned. Creating and refreshing that same
 * directory keeps this plugin's refresh and the app's refresh mutually
 * exclusive.
 */
async function withAuthLock(lockPath, operation, options = {}) {
  const directory = `${lockPath}.lock`
  const staleMs = options.staleMs ?? 30000
  const deadline = Date.now() + (options.timeoutMs ?? 20000)
  let acquired = false
  while (!acquired) {
    try {
      await mkdir(directory)
      acquired = true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let entry
      try {
        entry = await stat(directory)
      } catch {
        continue
      }
      if (Date.now() - entry.mtimeMs > staleMs) {
        await rmdir(directory).catch(() => {})
        continue
      }
      if (Date.now() > deadline) {
        throw new CheckinUnavailableError('The MiniMax sign-in refresh is busy; retry shortly.', { code: 'MINIMAX_CHECKIN_LOCK_TIMEOUT' })
      }
      await new Promise(resolveSleep => { setTimeout(resolveSleep, 40 + Math.random() * 120) })
    }
  }
  const heartbeat = setInterval(() => {
    const now = new Date()
    void utimes(directory, now, now).catch(() => {})
  }, Math.max(1000, Math.floor(staleMs / 3)))
  heartbeat.unref?.()
  try {
    return await operation()
  } finally {
    clearInterval(heartbeat)
    await rmdir(directory).catch(() => {})
  }
}

/** Write a private file through a same-directory temporary name. */
async function writePrivateFile(path, text) {
  const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`
  await writeFile(temporary, text, { mode: 0o600 })
  try {
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/**
 * The MiniMax Code sign-in this account already stores.
 *
 * The plugin never signs in on its own: it borrows the OAuth grant MiniMax
 * Code wrote under `~/.minimax/auth`, refreshes it in place when it is about
 * to expire, and leaves error recovery (a rejected refresh token) to the app.
 */
export class MinimaxAuth {
  constructor(options) {
    this.options = options
    this.cached = undefined
    this.lastError = undefined
    this.refreshing = undefined
  }

  /** The directory holding the app's OAuth files. */
  paths() {
    const home = this.options.minimaxHome === undefined || this.options.minimaxHome.length === 0
      ? (process.env.MINIMAX_HOME ?? join(homedir(), '.minimax'))
      : this.options.minimaxHome
    const authHome = join(resolve(home), 'auth')
    const namespaceHome = join(authHome, this.options.buildEnv, this.options.region, 'mcode-public')
    const service = `com.minimax.mcode.oauth.${this.options.buildEnv}.${this.options.region}`
    const account = createHash('sha256').update(`${authHome}\0mcode-public`).digest('base64url')
    return {
      authHome,
      namespaceHome,
      credentialPath: join(namespaceHome, 'auth.json'),
      statePath: join(namespaceHome, 'auth-state.json'),
      lockPath: join(namespaceHome, 'auth.lock'),
      recordKey: `${service}\0${account}`,
      service,
      account,
    }
  }

  /** The newest usable record in one credential payload. */
  recordOf(payload) {
    const records = payload?.records !== undefined && typeof payload.records === 'object' ? payload.records : {}
    const paths = this.paths()
    const exact = records[paths.recordKey]
    if (exact !== undefined) return { key: paths.recordKey, record: exact }
    for (const [key, record] of Object.entries(records)) {
      if (typeof record?.accessToken === 'string' && record.accessToken.length > 0) return { key, record }
    }
    return undefined
  }

  /** Read the app's credential store, or throw a sign-in guidance error. */
  async readCredential() {
    const paths = this.paths()
    let text
    try {
      text = await readFile(paths.credentialPath, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new CheckinUnavailableError('MiniMax Code is not signed in on this machine; open MiniMax Code once and sign in so the daily check-in can run.', { code: 'MINIMAX_CHECKIN_NO_SIGN_IN' })
      }
      throw error
    }
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new CheckinUnavailableError('The MiniMax Code sign-in file is unreadable; open MiniMax Code to repair it.', { code: 'MINIMAX_CHECKIN_CORRUPT_SIGN_IN' })
    }
    const found = this.recordOf(payload)
    if (found === undefined || typeof found.record.accessToken !== 'string') {
      throw new CheckinUnavailableError('MiniMax Code is not signed in on this machine; open MiniMax Code once and sign in so the daily check-in can run.', { code: 'MINIMAX_CHECKIN_NO_SIGN_IN' })
    }
    return { payload, ...found, paths }
  }

  /**
   * The current access token, refreshed when it is within the skew window.
   *
   * @param options.force - refresh even when the stored token still looks valid.
   */
  async token(options = {}) {
    const cached = this.cached
    if (cached !== undefined && options.force !== true && cached.expiresAtMs - Date.now() > this.options.refreshSkewMs) {
      return cached.accessToken
    }
    let current
    try {
      current = await this.readCredential()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
    const expiresAtMs = numberOf(current.record.expiresAtMs) ?? 0
    if (expiresAtMs - Date.now() > this.options.refreshSkewMs && options.force !== true) {
      this.cached = { accessToken: current.record.accessToken, expiresAtMs }
      this.lastError = undefined
      return current.record.accessToken
    }
    return await this.refresh(current, options.force === true)
  }

  /** Refresh the grant once, under the shared auth lock. */
  async refresh(observed, force) {
    if (this.refreshing !== undefined) return this.refreshing
    const paths = this.paths()
    const run = async () => {
      const current = await this.readCredential()
      const expiresAtMs = numberOf(current.record.expiresAtMs) ?? 0
      if (force !== true && expiresAtMs - Date.now() > this.options.refreshSkewMs) {
        this.cached = { accessToken: current.record.accessToken, expiresAtMs }
        return current.record.accessToken
      }
      const grant = await this.requestRefresh(current.record.refreshToken)
      const generation = Math.max(numberOf(current.record.generation) ?? 0, await this.stateGeneration()) + 1
      const record = {
        ...current.record,
        schemaVersion: 1,
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        tokenType: 'Bearer',
        clientId: 'mcode-public',
        scopes: grant.scopes,
        audience: 'agent-backend',
        expiresAtMs: grant.expiresAtMs,
        generation,
        loginEpoch: current.record.loginEpoch ?? randomUUID(),
      }
      const payload = {
        schemaVersion: 1,
        records: { ...(current.payload.records ?? {}), [current.key]: record },
      }
      await writePrivateFile(paths.credentialPath, `${JSON.stringify(payload, null, 2)}\n`)
      const state = {
        schemaVersion: 2,
        status: 'authenticated',
        storeKind: 'file',
        clientId: 'mcode-public',
        scopes: grant.scopes,
        audience: 'agent-backend',
        buildEnv: paths.buildEnv,
        region: paths.region,
        generation,
        expiresAtMs: grant.expiresAtMs,
      }
      await writePrivateFile(paths.statePath, `${JSON.stringify(state, null, 2)}\n`)
      await unlink(join(paths.namespaceHome, 'refresh', 'auth.json')).catch(() => {})
      this.cached = { accessToken: grant.accessToken, expiresAtMs: grant.expiresAtMs }
      this.lastError = undefined
      return grant.accessToken
    }
    this.refreshing = withAuthLock(paths.lockPath, run)
    try {
      return await this.refreshing
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.refreshing = undefined
    }
  }

  /** The generation of the last committed auth state, when present. */
  async stateGeneration() {
    try {
      const state = JSON.parse(await readFile(this.paths().statePath, 'utf8'))
      return numberOf(state?.generation) ?? 0
    } catch {
      return 0
    }
  }

  /** Trade the refresh token for a new grant. */
  async requestRefresh(refreshToken) {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'mcode-public',
      scope: 'agent.default',
      audience: 'agent-backend',
    })
    let response
    try {
      response = await this.options.fetchImpl(this.options.tokenURL, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20000),
      })
    } catch (error) {
      throw new CheckinUnavailableError(`The MiniMax sign-in could not be refreshed: ${error instanceof Error ? error.message : String(error)}`, { code: 'MINIMAX_CHECKIN_REFRESH_NETWORK' })
    }
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new CheckinUnavailableError(`The MiniMax sign-in service answered HTTP ${String(response.status)}.`, { code: 'MINIMAX_CHECKIN_REFRESH_HTTP' })
    }
    const errorCode = typeof body?.error === 'string' ? body.error : undefined
    if (!response.ok || errorCode !== undefined) {
      if (errorCode === 'invalid_grant' || response.status === 400) {
        throw new CheckinUnavailableError('The MiniMax Code sign-in has expired; open MiniMax Code and sign in again so the daily check-in can continue.', { code: 'MINIMAX_CHECKIN_SIGN_IN_EXPIRED' })
      }
      throw new CheckinUnavailableError(`The MiniMax sign-in service answered HTTP ${String(response.status)}${errorCode === undefined ? '' : ` (${errorCode})`}.`, { code: 'MINIMAX_CHECKIN_REFRESH_HTTP' })
    }
    const accessToken = typeof body?.access_token === 'string' ? body.access_token : undefined
    const nextRefresh = typeof body?.refresh_token === 'string' ? body.refresh_token : undefined
    const expiresIn = numberOf(body?.expires_in)
    const tokenType = typeof body?.token_type === 'string' ? body.token_type : 'Bearer'
    if (accessToken === undefined || nextRefresh === undefined || expiresIn === undefined || expiresIn <= 0 || tokenType.toLowerCase() !== 'bearer') {
      throw new CheckinUnavailableError('The MiniMax sign-in service returned an unusable grant.', { code: 'MINIMAX_CHECKIN_REFRESH_INVALID' })
    }
    const scopes = typeof body?.scope === 'string' && body.scope.trim().length > 0
      ? body.scope.trim().split(/\s+/u)
      : ['agent.default']
    return { accessToken, refreshToken: nextRefresh, expiresAtMs: Date.now() + expiresIn * 1000, scopes }
  }

  /** The current access token without refreshing it; undefined when expired. */
  async peekToken() {
    try {
      const current = await this.readCredential()
      const expiresAtMs = numberOf(current.record.expiresAtMs) ?? 0
      return expiresAtMs > Date.now() ? current.record.accessToken : undefined
    } catch {
      return undefined
    }
  }

  /** A status reading that never refreshes and never throws. */
  async status() {
    try {
      const current = await this.readCredential()
      const expiresAtMs = numberOf(current.record.expiresAtMs) ?? 0
      return {
        ok: true,
        source: 'miniMaxCode',
        expiresInMs: Math.max(0, expiresAtMs - Date.now()),
        needsRefresh: expiresAtMs - Date.now() <= this.options.refreshSkewMs,
        refreshing: this.refreshing !== undefined,
      }
    } catch (error) {
      return {
        ok: false,
        source: 'miniMaxCode',
        reason: error instanceof Error ? error.message : String(error),
        code: error?.code ?? 'MINIMAX_CHECKIN_UNAVAILABLE',
      }
    }
  }
}

/**
 * The daily check-in client for one MiniMax account.
 *
 * The requests carry the same OAuth bearer, query parameters, and signature
 * headers the MiniMax Code desktop client sends, so the endpoints answer the
 * plugin exactly as they answer the app.
 */
export class SigninClient {
  constructor(options) {
    this.options = options
    this.fetchImpl = options.fetchImpl ?? fetch
    this.auth = options.auth
  }

  /** The query parameters the desktop client sends with every request. */
  params(timeMs) {
    return {
      device_platform: 'web',
      biz_id: '3',
      app_id: '3001',
      version_code: '22201',
      unix: String(timeMs),
      timezone_offset: String(-60 * new Date().getTimezoneOffset()),
      is_desktop: '1',
      desktop_version: this.options.appVersion,
      sys_language: 'en',
      lang: 'en',
      device_id: '0',
      os_name: osName(),
      browser_name: 'Chrome',
      user_id: '0',
      screen_width: '1920',
      screen_height: '1080',
      client: 'desktop',
    }
  }

  /** The headers the desktop client signs its requests with. */
  headers(path, method, bodyText, token) {
    const timeMs = Date.now()
    const second = Math.floor(timeMs / 1000)
    const query = new URLSearchParams(this.params(timeMs)).toString()
    const signed = `${path}?${query}`
    return {
      url: signed,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-timestamp': String(second),
        'x-signature': md5(`${second}${REQUEST_SIGNATURE_SECRET}${method === 'POST' ? bodyText : ''}`),
        yy: md5(`${encodeURIComponent(signed)}_${method === 'POST' ? bodyText : ''}${md5(String(timeMs))}ooui`),
        'user-agent': 'MiniMaxCode',
      },
    }
  }

  /** Send one signed request and return the parsed body. */
  async request(path, method, body) {
    const bodyText = method === 'POST' ? JSON.stringify(body ?? {}) : ''
    const token = await this.auth.token()
    const signed = this.headers(path, method, bodyText, token)
    const url = `${withoutSlash(this.options.apiBaseURL)}${signed.url}`
    let response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: signed.headers,
        body: method === 'POST' ? bodyText : undefined,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20000),
      })
    } catch (error) {
      throw new CheckinUnavailableError(`The MiniMax check-in service could not be reached: ${error instanceof Error ? error.message : String(error)}`, { code: 'MINIMAX_CHECKIN_NETWORK' })
    }
    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new CheckinUnavailableError(`The MiniMax check-in service answered HTTP ${String(response.status)} with a non-JSON body.`, { code: 'MINIMAX_CHECKIN_HTTP' })
    }
    const status = numberOf(payload?.base_resp?.status_code)
    if (!response.ok || (status !== undefined && status !== 0)) {
      const message = typeof payload?.base_resp?.status_msg === 'string' ? payload.base_resp.status_msg : `HTTP ${String(response.status)}`
      if (response.status === 401) {
        throw new CheckinUnavailableError('MiniMax rejected the sign-in for this request; open MiniMax Code and sign in again.', { code: 'MINIMAX_CHECKIN_UNAUTHORIZED' })
      }
      throw new CheckinUnavailableError(`The MiniMax check-in service refused the request: ${message}`, { code: 'MINIMAX_CHECKIN_REFUSED' })
    }
    const data = payload?.data
    if (data === undefined || data === null) {
      throw new CheckinUnavailableError('The MiniMax check-in response carried no data.', { code: 'MINIMAX_CHECKIN_EMPTY' })
    }
    return data
  }

  /** The daily check-in panel for this account. */
  async panel() {
    const data = await this.request(`${SIGNIN_PATH}/status`, 'GET')
    return normalizePanel(data)
  }

  /** Claim today's reward and return the claim result with a fresh panel. */
  async claim() {
    const data = await this.request(`${SIGNIN_PATH}/claim`, 'POST', {})
    const panel = data.panel === undefined ? undefined : normalizePanel(data.panel)
    return {
      claimId: typeof data.claim_id === 'string' ? data.claim_id : undefined,
      claimResult: numberOf(data.claim_result),
      dayNo: numberOf(data.day_no),
      points: numberOf(data.points),
      expireAtMs: numberOf(data.expire_at_ms),
      panel,
    }
  }
}

/**
 * One check-in panel in the shape the plugin reports.
 *
 * @param {object} data - the raw `data` object of the status reply.
 * @returns {object} the normalized panel.
 */
export function normalizePanel(data) {
  const days = Array.isArray(data?.days) ? data.days : []
  const normalized = days
    .filter(day => day !== null && typeof day === 'object')
    .map(day => ({
      dayNo: numberOf(day.day_no) ?? 0,
      points: numberOf(day.points) ?? 0,
      bonusPoints: numberOf(day.bonus_points) ?? 0,
      status: numberOf(day.status) ?? DayStatus.Upcoming,
      isToday: day.is_today === true,
    }))
    .sort((left, right) => left.dayNo - right.dayNo)
  const today = normalized.find(day => day.isToday)
  const claimable = normalized.find(day => day.status === DayStatus.Claimable)
  // The streak counts the consecutive claimed days that end at today. While
  // today is still claimable it is not part of the streak yet, so the count
  // starts at yesterday; once today is claimed it starts at today.
  let streak = 0
  const todayIndex = normalized.findIndex(day => day.isToday)
  if (todayIndex >= 0) {
    const todayStatus = normalized[todayIndex].status
    let index = todayStatus === DayStatus.Claimed ? todayIndex : todayStatus === DayStatus.Claimable ? todayIndex - 1 : -1
    for (; index >= 0 && normalized[index].status === DayStatus.Claimed; index -= 1) streak += 1
  }
  return {
    scene: numberOf(data?.scene) ?? 0,
    days: normalized,
    streak,
    today: today ?? null,
    claimable: claimable ?? null,
    claimedToday: normalized.some(day => day.isToday && day.status === DayStatus.Claimed),
    claimableNow: normalized.some(day => day.status === DayStatus.Claimable),
  }
}

/** The local calendar day of one instant, as `YYYY-MM-DD`. */
export function localDayKey(at = Date.now()) {
  const date = new Date(at)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Milliseconds until the next local occurrence of one hour of the day. */
export function millisUntilHour(hour, at = Date.now()) {
  const date = new Date(at)
  const target = new Date(at)
  target.setHours(hour, 0, 0, 0)
  if (target.getTime() <= at) target.setDate(target.getDate() + 1)
  return target.getTime() - at
}

/** Answer with JSON. */
function sendJSON(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Apply the plugin: the check-in client, its tool, its routes, and optionally
 * a daily scheduled claim.
 */
export function apply(ctx, config) {
  const settings = {
    enabled: readConfig(config, 'enabled', true),
    minimaxHome: readConfig(config, 'minimaxHome', ''),
    buildEnv: readConfig(config, 'buildEnv', 'prod'),
    region: readConfig(config, 'region', 'en'),
    apiBaseURL: readConfig(config, 'apiBaseURL', 'https://agent.minimax.io'),
    oauthTokenURL: readConfig(config, 'oauthTokenURL', ''),
    appVersion: readConfig(config, 'appVersion', '3.1.14'),
    refreshSkewMs: readConfig(config, 'refreshSkewMs', 600000),
    timeoutMs: readConfig(config, 'timeoutMs', 20000),
    statusPath: readConfig(config, 'statusPath', '/plugins/minimax-checkin/status'),
    claimPath: readConfig(config, 'claimPath', '/plugins/minimax-checkin/claim'),
    autoCheckIn: readConfig(config, 'autoCheckIn', false),
    autoCheckInHour: readConfig(config, 'autoCheckInHour', 9),
  }
  const logger = ctx.logger
  const oauthTokenURL = settings.oauthTokenURL || oauthTokenURLFor(settings.region)
  const auth = new MinimaxAuth({
    minimaxHome: settings.minimaxHome,
    buildEnv: settings.buildEnv,
    region: settings.region,
    tokenURL: oauthTokenURL,
    refreshSkewMs: settings.refreshSkewMs,
    timeoutMs: settings.timeoutMs,
    fetchImpl: fetch,
  })
  const client = new SigninClient({
    apiBaseURL: settings.apiBaseURL,
    appVersion: settings.appVersion,
    timeoutMs: settings.timeoutMs,
    auth,
  })

  const state = {
    enabled: settings.enabled,
    lastClaim: undefined,
    lastError: undefined,
    lastRunAt: undefined,
  }

  /** The panel plus the sign-in state, as the Web GUI and the tool report it. */
  const readStatus = async () => {
    const token = await auth.status()
    let panel
    let failure
    try {
      panel = await client.panel()
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    return {
      ok: panel !== undefined,
      enabled: state.enabled,
      autoCheckIn: settings.autoCheckIn,
      autoCheckInHour: settings.autoCheckInHour,
      panel: panel ?? null,
      token,
      lastClaim: state.lastClaim,
      lastRunAt: state.lastRunAt,
      lastError: failure ?? state.lastError,
      updatedAt: new Date().toISOString(),
    }
  }

  /** Claim the daily reward, recording what happened. */
  const runClaim = async () => {
    const result = await client.claim()
    const claimed = result.claimResult === ClaimResult.Claimed
    state.lastClaim = {
      at: new Date().toISOString(),
      day: localDayKey(),
      dayNo: result.dayNo,
      points: result.points,
      claimed,
      alreadyClaimed: result.claimResult === ClaimResult.AlreadyClaimed,
    }
    state.lastRunAt = state.lastClaim.at
    state.lastError = undefined
    return result
  }

  if (settings.enabled === true) {
    const dispose = ctx.tools.register({
      name: 'minimax_daily_checkin',
      description: 'Reads the MiniMax daily check-in panel and claims the daily credit reward for the account that MiniMax Code is signed in to. The claim is a one-time action per day; MiniMax refuses a second claim on the same day.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'claim'],
            description: '"status" reads today\'s check-in panel without claiming anything. "claim" claims today\'s reward and reports the points it granted.',
          },
        },
        required: [],
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: renderToolResult(value) }],
      },
      timeoutMs: Math.max(30000, settings.timeoutMs * 2),
      async execute(args) {
        const action = args?.action === 'claim' ? 'claim' : 'status'
        if (action === 'status') {
          const status = await readStatus()
          return jsonSafe({
            ok: status.ok,
            action: 'status',
            panel: status.panel,
            token: status.token,
            lastClaim: status.lastClaim,
            lastError: status.lastError,
          })
        }
        const result = await runClaim()
        return jsonSafe({
          ok: true,
          action: 'claim',
          claimed: result.claimResult === ClaimResult.Claimed,
          alreadyClaimed: result.claimResult === ClaimResult.AlreadyClaimed,
          dayNo: result.dayNo,
          points: result.points,
          panel: result.panel,
        })
      },
      presentCall(args) {
        return { card: 'generic', title: args?.action === 'claim' ? 'MiniMax daily check-in' : 'MiniMax check-in status', kind: 'other' }
      },
    })
    ctx.effect(() => dispose, 'minimax-checkin: tool')

    ctx.effect(() => {
      const disposeStatus = ctx.webServer.register({
        kind: 'exact',
        path: settings.statusPath,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405)
            res.end()
            return
          }
          void readStatus().then(body => {
            sendJSON(res, 200, body)
          }).catch(error => {
            sendJSON(res, 500, { ok: false, lastError: error instanceof Error ? error.message : String(error) })
          })
        },
      })
      const disposeClaim = ctx.webServer.register({
        kind: 'exact',
        path: settings.claimPath,
        handler: (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405)
            res.end()
            return
          }
          void runClaim().then(result => {
            sendJSON(res, 200, {
              ok: true,
              claimed: result.claimResult === ClaimResult.Claimed,
              alreadyClaimed: result.claimResult === ClaimResult.AlreadyClaimed,
              dayNo: result.dayNo,
              points: result.points,
              panel: result.panel,
            })
          }).catch(error => {
            sendJSON(res, 502, {
              ok: false,
              code: error?.code ?? 'MINIMAX_CHECKIN_UNAVAILABLE',
              message: error instanceof Error ? error.message : String(error),
            })
          })
        },
      })
      return () => {
        disposeStatus()
        disposeClaim()
      }
    }, 'minimax-checkin: routes')

    if (settings.autoCheckIn === true) {
      ctx.effect(() => {
        let timer
        let stopped = false
        /** Run the scheduled claim, then wait for the next local hour. */
        const tick = async () => {
          if (stopped) return
          try {
            const today = localDayKey()
            if (state.lastClaim?.day !== today) {
              const panel = await client.panel()
              if (panel.claimableNow === true) {
                const result = await runClaim()
                logger?.info?.(`minimax-checkin: claimed day ${String(result.dayNo)} for ${String(result.points)} credits`)
              }
            }
          } catch (error) {
            state.lastError = error instanceof Error ? error.message : String(error)
            logger?.warn?.(`minimax-checkin: the scheduled check-in failed: ${state.lastError}`)
          }
          if (stopped) return
          timer = setTimeout(() => { void tick() }, millisUntilHour(settings.autoCheckInHour))
          timer.unref?.()
        }
        timer = setTimeout(() => { void tick() }, millisUntilHour(settings.autoCheckInHour))
        timer.unref?.()
        return () => {
          stopped = true
          clearTimeout(timer)
        }
      }, 'minimax-checkin: daily schedule')
    }
  } else {
    logger?.info?.('minimax-checkin: the plugin is disabled; no check-in tool or route is registered.')
  }
}

/** The one-line summary of one tool result. */
export function renderToolResult(value) {
  if (value === undefined || value === null) return 'MiniMax check-in: no result.'
  if (value.ok === false) {
    const reason = value.lastError ?? value.message ?? 'the check-in service refused the request'
    return `MiniMax check-in failed: ${reason}`
  }
  if (value.action === 'claim') {
    if (value.alreadyClaimed === true) return 'MiniMax check-in: today\'s reward was already claimed.'
    return `MiniMax check-in: claimed ${String(value.points)} credits for day ${String(value.dayNo)}.`
  }
  const panel = value.panel
  if (panel === undefined || panel === null) return 'MiniMax check-in: the panel could not be read.'
  const today = panel.today
  const state = panel.claimedToday === true
    ? 'already claimed today'
    : panel.claimableNow === true
      ? `claimable for ${String(today?.points ?? 0)} credits`
      : 'not claimable yet'
  return `MiniMax check-in: ${state}. Streak ${String(panel.streak)} day(s); ${String(panel.days.length)} day(s) in this cycle.`
}
