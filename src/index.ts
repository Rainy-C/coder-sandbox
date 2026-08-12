import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()

// Home
app.get('/', (req, res) => {
  res.type('html').send(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8"/>
        <title>Coder Sandbox Proxy</title>
      </head>
      <body>
        <h1>Coder Sandbox Proxy</h1>
        <p>Vercel proxy is running.</p>
        <p><a href="/api/test">Test ovo.chenqwq.cn</a></p>
        <p><a href="/healthz">Health</a></p>
      </body>
    </html>
  `)
})

// 测试 Vercel 能否访问 ovo.chenqwq.cn
app.get('/api/test', async (req, res) => {
  const start = Date.now()

  try {
    const response = await fetch('https://ovo.chenqwq.cn/', {
      method: 'GET',
      headers: {
        'User-Agent': 'CoderSandbox-Vercel/1.0',
        Accept: '*/*',
      },
      signal: AbortSignal.timeout(15000),
    })

    const body = await response.text()

    res.status(200).json({
      ok: true,
      upstream: 'https://ovo.chenqwq.cn/',
      upstream_status: response.status,
      upstream_content_type: response.headers.get('content-type'),
      elapsed_ms: Date.now() - start,
      body,
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      ok: false,
      upstream: 'https://ovo.chenqwq.cn/',
      elapsed_ms: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
      cause:
        error instanceof Error && 'cause' in error
          ? String(error.cause)
          : null,
    })
  }
})

// 原来的 about
app.get('/about', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'components', 'about.htm'))
})

// Health check
app.get('/healthz', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  })
})

export default app
