import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dns from 'node:dns/promises'
import tls from 'node:tls'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()

app.use(express.json())

// ==============================
// 首页
// ==============================
app.get('/', (_req, res) => {
  res.type('html').send(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Coder Sandbox</title>
      </head>
      <body>
        <h1>Coder Sandbox Proxy</h1>
        <p>Vercel server is running.</p>

        <ul>
          <li><a href="/healthz">/healthz</a></li>
          <li><a href="/api/test">/api/test</a></li>
        </ul>
      </body>
    </html>
  `)
})

// ==============================
// 健康检查
// ==============================
app.get('/healthz', (_req, res) => {
  res.status(200).json({
    ok: true,
    status: 'running',
    timestamp: new Date().toISOString(),
  })
})

// ==============================
// 将错误转换成 JSON
// ==============================
function serializeError(error: unknown) {
  if (!(error instanceof Error)) {
    return {
      message: String(error),
    }
  }

  const result: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  }

  const anyError = error as Error & {
    code?: string
    errno?: number
    syscall?: string
    address?: string
    port?: number
    cause?: unknown
  }

  if (anyError.code !== undefined) {
    result.code = anyError.code
  }

  if (anyError.errno !== undefined) {
    result.errno = anyError.errno
  }

  if (anyError.syscall !== undefined) {
    result.syscall = anyError.syscall
  }

  if (anyError.address !== undefined) {
    result.address = anyError.address
  }

  if (anyError.port !== undefined) {
    result.port = anyError.port
  }

  if (anyError.cause !== undefined) {
    if (anyError.cause instanceof Error) {
      result.cause = serializeError(anyError.cause)
    } else {
      result.cause = String(anyError.cause)
    }
  }

  return result
}

// ==============================
// 单独测试某个 IP 的 TLS
// ==============================
function testTls(
  hostname: string,
  address: string,
  family: 4 | 6
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

    const socket = tls.connect({
      host: address,
      port: 443,
      family,
      servername: hostname,
      rejectUnauthorized: true,
      timeout: 5000,
    })

    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate()

      finish({
        ok: true,
        authorized: socket.authorized,
        authorization_error: socket.authorizationError ?? null,
        protocol: socket.getProtocol(),
        cipher: socket.getCipher(),
        certificate: {
          subject: certificate?.subject ?? null,
          issuer: certificate?.issuer ?? null,
          valid_from: certificate?.valid_from ?? null,
          valid_to: certificate?.valid_to ?? null,
        },
      })

      socket.destroy()
    })

    socket.once('timeout', () => {
      finish({
        ok: false,
        error: 'TLS timeout',
      })

      socket.destroy()
    })

    socket.once('error', (error) => {
      finish({
        ok: false,
        error: serializeError(error),
      })

      socket.destroy()
    })
  })
}

// ==============================
// 完整网络诊断
// ==============================
app.get('/api/test', async (_req, res) => {
  const hostname = 'ovo.chenqwq.cn'
  const targetUrl = `https://${hostname}/`

  const startedAt = Date.now()

  const result: {
    ok: boolean
    hostname: string
    target: string
    timestamp: string
    dns: unknown[]
    tls: unknown[]
    fetch: unknown
    elapsed_ms?: number
    fatal_error?: unknown
  } = {
    ok: false,
    hostname,
    target: targetUrl,
    timestamp: new Date().toISOString(),
    dns: [],
    tls: [],
    fetch: null,
  }

  try {
    // ==============================
    // DNS 测试
    // ==============================
    try {
      const addresses = await dns.lookup(hostname, {
        all: true,
        verbatim: true,
      })

      result.dns = addresses.map((item) => ({
        address: item.address,
        family: item.family,
      }))

      // ==============================
      // 每个解析出来的 IP 单独测试 TLS
      // ==============================
      for (const item of addresses) {
        const tlsResult = await testTls(
          hostname,
          item.address,
          item.family as 4 | 6
        )

        result.tls.push(tlsResult)
      }
    } catch (error) {
      result.dns = [
        {
          ok: false,
          error: serializeError(error),
        },
      ]
    }

    // ==============================
    // 正常 fetch 测试
    // ==============================
    const fetchStartedAt = Date.now()

    try {
      const response = await fetch(targetUrl, {
        method: 'GET',

        headers: {
          'User-Agent': 'CoderSandbox-Vercel/1.0',
          Accept: '*/*',
          'Cache-Control': 'no-cache',
        },

        redirect: 'manual',

        cache: 'no-store',

        signal: AbortSignal.timeout(10000),
      })

      const body = await response.text()

      result.fetch = {
        ok: true,
        status: response.status,
        status_text: response.statusText,
        elapsed_ms: Date.now() - fetchStartedAt,

        headers: {
          server: response.headers.get('server'),
          date: response.headers.get('date'),
          location: response.headers.get('location'),
          content_type: response.headers.get('content-type'),
          content_length: response.headers.get('content-length'),
          cf_ray: response.headers.get('cf-ray'),
          via: response.headers.get('via'),
        },

        body: body.slice(0, 5000),
      }

      result.ok = true
    } catch (error) {
      result.fetch = {
        ok: false,
        elapsed_ms: Date.now() - fetchStartedAt,
        error: serializeError(error),
      }
    }

    result.elapsed_ms = Date.now() - startedAt

    res.status(200).json(result)
  } catch (error) {
    result.elapsed_ms = Date.now() - startedAt
    result.fatal_error = serializeError(error)

    res.status(500).json(result)
  }
})

// ==============================
// 原模板 About 页面
// ==============================
app.get('/about', (_req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      '..',
      'components',
      'about.htm'
    )
  )
})

// ==============================
// 404
// ==============================
app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Not Found',
  })
})

export default app
