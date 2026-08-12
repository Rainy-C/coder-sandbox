import express from 'express'
import dns from 'node:dns/promises'
import tls from 'node:tls'

const app = express()

app.use(express.json())

const VERSION = 'DIAG-V3'
const HOST = 'ovo.chenqwq.cn'
const TARGET = `https://${HOST}/`

function errorToJson(error: unknown): any {
  if (!(error instanceof Error)) {
    return {
      message: String(error),
    }
  }

  const e = error as any

  return {
    name: error.name,
    message: error.message,
    code: e.code ?? null,
    errno: e.errno ?? null,
    syscall: e.syscall ?? null,
    address: e.address ?? null,
    port: e.port ?? null,
    cause: e.cause ? errorToJson(e.cause) : null,
  }
}

function testTLS(
  address: string,
  family: 4 | 6
): Promise<any> {
  return new Promise((resolve) => {
    const start = Date.now()

    let done = false

    const finish = (data: any) => {
      if (done) return
      done = true

      resolve({
        address,
        family,
        elapsed_ms: Date.now() - start,
        ...data,
      })
    }

    const socket = tls.connect({
      host: address,
      port: 443,
      family,
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
          socket.authorizationError ?? null,
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

// 首页
app.get('/', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'coder-sandbox',
    version: VERSION,
    endpoints: {
      health: '/healthz',
      test: '/api/test',
    },
  })
})

// 健康检查
app.get('/healthz', (_req, res) => {
  res.status(200).json({
    ok: true,
    version: VERSION,
    timestamp: new Date().toISOString(),
  })
})

// 完整诊断
app.get('/api/test', async (_req, res) => {
  const totalStart = Date.now()

  const result: any = {
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

  // =========================
  // DNS
  // =========================
  let addresses: {
    address: string
    family: number
  }[] = []

  try {
    addresses = await dns.lookup(HOST, {
      all: true,
      verbatim: true,
    })

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

  // =========================
  // TLS
  // =========================
  for (const addr of addresses) {
    if (addr.family !== 4 && addr.family !== 6) {
      continue
    }

    try {
      const tlsResult = await testTLS(
        addr.address,
        addr.family as 4 | 6
      )

      result.tls.push(tlsResult)
    } catch (error) {
      result.tls.push({
        address: addr.address,
        family: addr.family,
        ok: false,
        error: errorToJson(error),
      })
    }
  }

  // =========================
  // fetch
  // =========================
  const fetchStart = Date.now()

  try {
    const controller = new AbortController()

    const timer = setTimeout(() => {
      controller.abort()
    }, 10000)

    try {
      const response = await fetch(TARGET, {
        method: 'GET',

        headers: {
          'User-Agent':
            'Mozilla/5.0 CoderSandbox-Vercel-Diagnostic/3.0',

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
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    result.fetch = {
      ok: false,

      elapsed_ms:
        Date.now() - fetchStart,

      error:
        errorToJson(error),
    }
  }

  result.elapsed_ms =
    Date.now() - totalStart

  // 故意始终返回 HTTP 200
  // 防止 Vercel / 浏览器只显示 500 页面
  res.status(200).json(result)
})

// 404
app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    version: VERSION,
    error: 'Not Found',
  })
})

export default app
