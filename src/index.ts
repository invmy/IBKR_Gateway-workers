import { Hono, Context } from 'hono'
import { cors } from 'hono/cors'
import { authWithLimit } from './middleware/authWithLimit'
import { DurableObject } from "cloudflare:workers";
import { auth, ibkrFetch, init } from './service/ibkr'
import { connect } from 'cloudflare:sockets'
import { sign } from 'hono/jwt'

let session = null as any
let accessToken = null as any

export class ibkrDO extends DurableObject<Bindings> {
  private encoder = new TextEncoder();

  private ibkrWs: WebSocket | null = null;
  private sseChannels: Map<string, Set<ReadableStreamDefaultController>> = new Map();
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (session == null) {
      return new Response("no session，pls tickle", { status: 401 });
    }
    await this.ensureIbkrConnection();

    //TIC
    if (url.pathname.endsWith("/tic")) {
      const Command = 'tic';
      if (this.ibkrWs?.readyState === WebSocket.OPEN) {
        this.ibkrWs.send(Command);
        return new Response(JSON.stringify({ status: "ok", cmd: Command }));
      }
      return new Response("IBKR Connection offline", { status: 503 });
    }

    //any command
    if (url.pathname.endsWith("/command") && request.method === "POST") {

      const body = await request.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return new Response(JSON.stringify({ error: "Invalid body format" }), { status: 400 });
      }
      const { action, channel, symbol } = body as any;

      const ProtocolDictionary: Record<string, Record<string, (symbol: string) => string>> = {
        quotes: {
          sub: (s) => `smd+${s}+{"fields":["82","83","55","7221","7051","7295","7741","7635","86","84","70","71","7762"]}`,
          unsub: (s) => `umd+${s}+{}`
        },
        account: {
          sub: (s) => `ssd+${s}+{"keys":["AccruedCash-S","ExcessLiquidity-S"],"fields":["currency","monetaryValue"]}`,
          unsub: (s) => `usd+${s}+{}`
        },
      };
      const formatCommand = ProtocolDictionary[channel]?.[action];

      if (!formatCommand) {
        return new Response("Invalid command", { status: 400 });
      }
      const Command = formatCommand(symbol);

      if (this.ibkrWs?.readyState === WebSocket.OPEN) {
        this.ibkrWs.send(Command);
        return new Response(JSON.stringify({ status: "ok", cmd: Command }));
      }
      return new Response("IBKR Connection offline", { status: 503 });
    }

    // SSE
    if (url.pathname.endsWith("/sse")) {

      const channelName = url.searchParams.get("channel") || "default";
      let clientController: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start: (controller) => {
          clientController = controller;
          if (!this.sseChannels.has(channelName)) {
            this.sseChannels.set(channelName, new Set());
          }
          this.sseChannels.get(channelName)!.add(controller);
          controller.enqueue(this.encoder.encode(`event: connected\ndata: joined channel [${channelName}]\n\n`));

        },
        cancel: () => {
          this.sseChannels.get(channelName)?.delete(clientController);
          if (this.sseChannels.get(channelName)?.size === 0) {
            this.sseChannels.delete(channelName);
          }
        }
      });

      // SSE Response
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    return new Response(`Not Found: ${url.pathname}`, { status: 404 });
  }

  private broadcastToChannel(channelName: string, data: string) {
    const channel = this.sseChannels.get(channelName);
    if (!channel?.size) return;

    const payload = this.encoder.encode(`data: ${data}\n\n`);
    for (const ctrl of channel) {
      try { ctrl.enqueue(payload); }
      catch { channel.delete(ctrl); }
    }
  }

  private broadcastToAllChannels(data: string) {
    for (const channelName of this.sseChannels.keys()) {
      this.broadcastToChannel(channelName, data);
    }
  }


  // ==========================================
  private async ensureIbkrConnection() {
    if (this.ibkrWs && this.ibkrWs.readyState === WebSocket.OPEN) return;

    const url = `https://api.ibkr.com/v1/api/ws?oauth_token=${accessToken}`;

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          'Connection': 'Upgrade',
          'Upgrade': 'websocket',
          'origin': 'https://interactivebrokers.github.io',
          "Cookie": `api=${session}`,
          'User-Agent': 'Mozilla/5.0'
        }
      });

      if (response.status !== 101 || !response.webSocket) return;

      this.ibkrWs = response.webSocket;
      this.ibkrWs.accept();
      this.ibkrWs.addEventListener("close", () => {
        this.ibkrWs = null;
        this.broadcastToAllChannels(JSON.stringify({ error: "IBKR Disconnected" }));
      });
      this.ibkrWs.addEventListener("message", async (event) => {
        let textData: string;

        try {
          if (event.data instanceof Blob) {
            textData = await event.data.text();
          } else if (event.data instanceof ArrayBuffer) {
            textData = new TextDecoder().decode(event.data);
          } else if (typeof event.data === "string") {
            textData = event.data;
          } else {
            textData = String(event.data);
          }
          console.log("[DEBUG] WS Text:", textData);

        } catch (err) {
          console.error("[DEBUG] Data Error", err);
          return;
        }

        // ==================== JSON  ====================
        let parsed;
        try {
          parsed = JSON.parse(textData);
        } catch (e) {
          console.error("[DEBUG] JSON Error:", e);
          console.error("[DEBUG] data error:", textData.substring(0, 300) + "...");
          return;
        }

        if (!parsed?.topic) {
          console.warn("[DEBUG] no topic :", parsed);
          return;
        }

        const topic = String(parsed.topic).toLowerCase();

        const channelMap: Record<string, string> = {
          "smd": "quotes",
          "ssd": "account",
        };

        for (const [key, channel] of Object.entries(channelMap)) {
          if (topic.includes(key)) {
            this.broadcastToChannel(channel, JSON.stringify(parsed));
            return;
          }
        }
      });
    } catch (err) {
      console.error("DEBUG: IBKR connection error:", err);
    }
  }

}


export type Bindings = {
  MY_KV: KVNamespace,
  IBKRDO: DurableObjectNamespace,
  authUser: string,
  authPwd: string,
  JWT_SECRET: string,
  baseHost: string,
  consumerKey: string,
  accessToken: string,
  accessTokenSecret: string,
  dhParam: string,
  encryptionKey: string,
  signatureKey: string,
}

const app = new Hono<{ Bindings: Bindings }>()


app.use('*', cors({
  origin: (origin) => origin,
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'WWW-Authenticate', 'Cache-Control', 'Pragma'],
  exposeHeaders: ['WWW-Authenticate'],
}))

app.get('/tcpping', async (c) => {
  const host = c.req.query('host') || c.env.baseHost
  const port = parseInt(c.req.query('port') || '443')

  const startTime = performance.now()

  try {
    const socket = connect({ hostname: host, port: port })
    await socket.opened
    const latency = performance.now() - startTime
    await socket.close()
    return c.json({ success: true, host, port, latency: `${latency.toFixed(2)}ms` })
  } catch (err: any) {
    return c.json({ success: false, host, port, error: err.message }, 502)
  }
})


// auth
app.use('/api/*', authWithLimit)

//DO
app.get('/api/tic', async (c) => {
  const id = c.env.IBKRDO.idFromName('ibkr-one');
  const stub = c.env.IBKRDO.get(id);
  return stub.fetch(new Request(c.req.raw));
});
app.post('/api/command', async (c) => {
  const id = c.env.IBKRDO.idFromName('ibkr-one');
  const stub = c.env.IBKRDO.get(id);
  return stub.fetch(new Request(c.req.raw));
});

app.get('/api/sse', async (c) => {
  const id = c.env.IBKRDO.idFromName('ibkr-one');
  const stub = c.env.IBKRDO.get(id);
  const res = await stub.fetch(new Request(c.req.raw));
  return new Response(res.body, {
    status: res.status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

app.get('/api/get-token', async (c) => {
  const payload = {
    sub: 'ibkr',
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60
  }
  const jwtToken = await sign(payload, c.env.JWT_SECRET)
  return c.text('Expires in 12 hours Your token：' + jwtToken);
});

app.get('/api/auth', auth)
app.get('/api/init', init)
app.get('/api/tickle', async (c) => {
  const data = await ibkrFetch(c, 'POST', '/v1/api/tickle');
  if (data.error) {
    return c.text('ibkr error - ' + data.error, 500);
  }
  session = data.session
  accessToken = c.env.accessToken
  return c.json(data);
});

app.all('/api/ib/*', async (c) => {
  const method = c.req.method as "GET" | "POST" | "PUT" | "DELETE";
  const urlObj = new URL(c.req.url);
  const path = urlObj.pathname.replace(/^\/api\/ib/, '') + urlObj.search;

  let body = undefined;
  if (['POST', 'PUT', 'DELETE'].includes(method)) {
    body = await c.req.json().catch(() => undefined);
  }
  const result = await ibkrFetch(c, method, path, body);
  return typeof result === 'object' && result !== null
    ? c.json(result)
    : c.text(result);
});

export default app;
