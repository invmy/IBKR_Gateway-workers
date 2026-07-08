import { DurableObject } from "cloudflare:workers";
import { acquireLiveSessionToken, getStandardAuthHeader } from "./ibkr"

let baseurl = 'https://api.ibkr.com'

export class MyDurableObject extends DurableObject<Env> {
	private sessionCache: Map<string, any> = new Map();
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async fetch(request: Request) {
		if (request.headers.get("Upgrade") === "websocket") {
			return this.handleWS();
		}

		//routers
		const { pathname, search } = new URL(request.url);

		if (pathname === "/oauth") {
			const o = await this.IB_Oauth()
			return new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
		}

		let lst = await this.env.MY_KV.get('lst');
		for (let i = 0; i < 3; i++) {
			if (lst) break;
			console.log(`try ${i + 1} ...`);
			await this.IB_Oauth();
			lst = await this.env.MY_KV.get('lst');
		}
		if (!lst) {
			return new Response(JSON.stringify({ r: 'Auth failed after retry' }), { status: 500 });
		}

		const target = baseurl + pathname + search;

		const oauth_header = await getStandardAuthHeader(request.method, baseurl + pathname, this.env.consumerKey, this.env.accessToken, lst)
		const response = await fetch(target, {
			method: request.method,
			headers: { 'Authorization': oauth_header, "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "Accept": "*/*", 'Connection': 'keep-alive', 'Accept-Encoding': 'gzip,deflate', "Content-Type": "application/json" },
			body: request.body,
		});

		const newHeaders = new Headers(response.headers);
		newHeaders.delete("Content-Length");

		if (pathname === '/v1/api/tickle') {
			const resClone = response.clone();
			const data = await resClone.json();
			this.sessionCache.set('last_session_info', data);
		}
		return new Response(response.body, {
			status: response.status,
			headers: newHeaders,
		});
	}

	async IB_Oauth() {
		try {
			const creds = {
				consumerKey: this.env.consumerKey,
				accessToken: this.env.accessToken,
				accessTokenSecret: this.env.accessTokenSecret,
				baseHost: baseurl,
				dhParamPem: this.env.dhParam,
				encryptionKeyPem: this.env.encryptionKey,
				signatureKeyPem: this.env.signatureKey,
			}
			let { lst, expiration } = await acquireLiveSessionToken(creds)
			await this.env.MY_KV.put("lst", lst, {
				expiration: Math.floor(expiration / 1000)
			});
			return { success: true, data: expiration }
		} catch (error) {
			return { success: false, data: error }
		}
	}

	async handleWS(): Promise<Response> {
		const targetUrl = `https://api.ibkr.com/v1/api/ws?oauth_token=${this.env.accessToken}`;
		const last_cache = this.sessionCache.get('last_session_info')
		const sessionCookie = last_cache ? last_cache.session : '';
		if (!sessionCookie) {
			return new Response("Unauthorized: No Session Found", { status: 401 });
		}

		const response = await fetch(targetUrl, {
			method: "GET",
			headers: {
				"Upgrade": "websocket",
				"Connection": "Upgrade",
				"Origin": "https://interactivebrokers.github.io",
				"Cookie": `api=${sessionCookie}`,
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
			}
		});
		const webSocket = response.webSocket;
		if (!webSocket) {
			const errorText = await response.text();
			console.error("Connection Error:", response.status, errorText);
			return new Response("IBKR Handshake Failed: " + response.statusText, { status: 403 });
		}
		return new Response(null, {
			status: 101,
			webSocket: webSocket
		});
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const id = env.MY_DURABLE_OBJECT.idFromName("ibkr-web-api");
		const stub = env.MY_DURABLE_OBJECT.get(id);
		return await stub.fetch(request);
	},
} satisfies ExportedHandler<Env>;