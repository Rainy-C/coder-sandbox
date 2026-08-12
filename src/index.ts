import express from 'express'
import dns from 'node:dns/promises'
import tls from 'node:tls'

const app = express()

app.use(express.json())

const VERSION = 'DIAG-V4'
const HOST = 'ovo.chenqwq.cn'
const TARGET = `https://${HOST}/`

function errorToJson(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return {
      message: String(error),
    }
  }

  const e = error as Error & {
    code?: string
    errno?: number | string
    syscall?: string
    address?: string
    port?: number
    cause?: unknown
  }

  return {
    name: error.name,
    message: error.message,
    code: e.code ?? null,
    errno: e.errno ?? null,
    syscall: e.syscall ?? null,
    address: e.address ?? null,
    port: e.port ?? null,
    cause:
      e.cause !== undefined
        ? e.cause instanceof Error
          ? errorToJson(e.cause)
          : String(e.cause)
        : null,
  }
}

function testTLS(
  address: string,
  family: number
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const start = Date.now()

    let finished = false

    const finish = (data: Record<string, unknown>) => {
      if (finished) return
      finished = true

      resolve({
        address,
        family,
        elapsed_ms: Date.now() - start,
        ...data,
      })
    }

    // address 已经是具体 IPv4 / IPv6 地址
    // 不需要，也不能在 tls.connect ConnectionOptions 里传 family
    const socket = tls.connect({
      host: address,
      port: 443,
      servername: HOST,
      rejectUnauthorized: true,
    })

    socket.setTimeout(5000)

    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate()

      finish({
        ok: true,
        authorized: socket.authorized,
        authorization_error:
          socket.authorizationError instanceof Error
            ? socket.authorizationError.message
            : socket.authorizationError ?? null,
        protocol: socket.getProtocol(),
        cipher: socket.getCipher(),
        certificate: {
          subject: cert?.subject ?? null,
          issuer: cert?.issuer ?? null,
          valid_from: cert?.valid_from ?? null,
          valid_to: cert?.valid_to ?? null,
        },
      })

      socket.destroy()
    })

    socket.once('timeout', () => {
      finish({
        ok: false,
        error: {
          message: 'TLS timeout after 5000ms',
        },
      })

      socket.destroy()
    })

    socket.once('error', (error) => {
      finish({
        ok: false,
        error: errorToJson(error),
      })

      socket.destroy()
    })
  })
}

// ==============================
// 首页
// ==============================
app.get('/', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'coder-sandbox',
    version: VERSION,
    upstream: TARGET,
    endpoints: {
      health: '/healthz',
      test: '/api/test',
    },
  })
})

// ==============================
// 健康检查
// ==============================
app.get('/healthz', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'coder-sandbox',
    version: VERSION,
    timestamp: new Date().toISOString(),
  })
})

// ==============================
// DNS + TLS + FETCH 完整测试
// ==============================
app.get('/api/test', async (_req, res) => {
  const totalStart = Date.now()

  const result: {
    version: string
    ok: boolean
    upstream: string
    timestamp: string

    dns: {
      ok: boolean
      addresses: Array<{
        address: string
        family: number
      }>
      error: Record<string, unknown> | null
    }

    tls: Array<Record<string, unknown>>

    fetch: Record<string, unknown>

    elapsed_ms?: number
  } = {
    version: VERSION,
    ok: false,
    upstream: TARGET,
    timestamp: new Date().toISOString(),

    dns: {
      ok: false,
      addresses: [],
      error: null,
    },

    tls: [],

    fetch: {
      ok: false,
    },
  }

  // ==============================
  // 1. DNS
  // ==============================

  let addresses: Array<{
    address: string
    family: number
  }> = []

  try {
    const lookupResult = await dns.lookup(HOST, {
      all: true,
      verbatim: true,
    })

    addresses = lookupResult.map((item) => ({
      address: item.address,
      family: item.family,
    }))

    result.dns = {
      ok: true,
      addresses,
      error: null,
    }
  } catch (error) {
    result.dns = {
      ok: false,
      addresses: [],
      error: errorToJson(error),
    }
  }

  // ==============================
  // 2. 每个 DNS 地址测试 TLS
  // ==============================

  for (const item of addresses) {
    try {
      const tlsResult = await testTLS(
        item.address,
        item.family
      )

      result.tls.push(tlsResult)
    } catch (error) {
      result.tls.push({
        address: item.address,
        family: item.family,
        ok: false,
        error: errorToJson(error),
      })
    }
  }

  // ==============================
  // 3. 正常 HTTP Fetch
  // ==============================

  const fetchStart = Date.now()

  const controller = new AbortController()

  const timeout = setTimeout(() => {
    controller.abort()
  }, 10000)

  try {
    const response = await fetch(TARGET, {
      method: 'GET',

      headers: {
        'User-Agent':
          'Mozilla/5.0 CoderSandbox-Vercel-Diagnostic/4.0',

        Accept:
          'text/html,application/json,text/plain,*/*',

        'Cache-Control': 'no-cache',
      },

      redirect: 'manual',

      signal: controller.signal,
    })

    const body = await response.text()

    result.fetch = {
      ok: true,

      status: response.status,

      status_text: response.statusText,

      elapsed_ms:
        Date.now() - fetchStart,

      headers: {
        server:
          response.headers.get('server'),

        date:
          response.headers.get('date'),

        content_type:
          response.headers.get('content-type'),

        content_length:
          response.headers.get('content-length'),

        location:
          response.headers.get('location'),

        via:
          response.headers.get('via'),

        cf_ray:
          response.headers.get('cf-ray'),

        connection:
          response.headers.get('connection'),
      },

      body_preview:
        body.slice(0, 5000),
    }

    result.ok = true
  } catch (error) {
    result.fetch = {
      ok: false,

      elapsed_ms:
        Date.now() - fetchStart,

      error:
        errorToJson(error),
    }
  } finally {
    clearTimeout(timeout)
  }

  result.elapsed_ms =
    Date.now() - totalStart

  // 故意永远返回 HTTP 200
  // 方便直接查看诊断 JSON
  res.status(200).json(result)
})

// ==============================
// 404
// ==============================
app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    version: VERSION,
    error: 'Not Found',
  })
})

export default app
