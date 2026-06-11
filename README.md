# IBKR Web API Gateway For Cloudflare Workers
[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/invmy/IBKR_Gateway-workers)

Authentication uses Basic Authentication combined with a JWT token. Designed for use with browsers and APIs.


## Obtain a JWT token

run the `/api/get-token` endpoint

The request requires an Authorisation header to be set

`Authorisation: Bearer your-jwt-token`

## Basic Usage
The auth, init, and tickle methods are predefined.
If LST does not exist, run the `/api/auth` endpoint first. If you need full access, you must run the `/api/init` endpoint.

You must run the `/api/tickle`and`/api/tic` endpoints at least once every minute to keep the session active.


## Proxy for IBKR API requests

The `/api/ib/*` endpoints have been configured; you can enter any link after this.

```bash
#Example
/api/ib/v1/api/iserver/marketdata/snapshot?conids=265598,8314&fields=31,84,86
```

## TCP ping
Use tcpping to measure the TCP latency between Workers and api.ibkr.com

run the `/tcpping` endpoint

Supports configuration parameters such as `/tcpping?host=ibkr.com&port=443`

## Websocket Usage

We used Cloudflare's Durable Objects to connect to IBKR's WS server and utilized the SSE push service.

#### send command

Send a POST request to the /api/command endpoint with the Body content:

```json
// action: sub or unsub
// channel: channel name
// symbol: Parameters
{
  "action":"sub",
  "channel":"quotes",
  "symbol":"852103012"
}
```
If you need to customise the content you receive or define command operations, please modify the `ProtocolDictionary`

#### Receive push 

Use `/api/command` to retrieve received messages; supports the SSE messaging service

```bash
#/api/command?channel=channelname
/api/command?channel=quotes
```

Define in `channelMap` which channel a specific command topic should be sent to

## Vars

### basic

- baseHost : `api.ibkr.com`
- authUser : Enter the account 
- authPwd : Enter the password
- JWT_SECRET: A random JWT signing key,Any string, excluding special characters

### [IBKR OAuth1.0a](https://github.com/Voyz/ibind/wiki/OAuth-1.0a)

- consumerKey
- accessToken
- accessTokenSecret

You need to use a single command to compress the original PEM file into a single line, rather than multiple lines.

Linux / macOS：`sed '/-----/d' key.pem | tr -d '\n'`

Windows PowerShell：`(Get-Content key.pem -Raw) -replace '-----.*?-----' -replace '\r?\n' -replace '\s+',''`

- dhParam
- encryptionKey
- signatureKey