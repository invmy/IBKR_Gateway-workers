interface IBKRCredentials {
    consumerKey: string;
    accessToken: string;
    accessTokenSecret: string;
    encryptionKeyPem: string;
    signatureKeyPem: string;
    dhParamPem: string;
}

/**
 * Perform a DH key exchange, decrypt, and calculate the returned Live Session Token (LST).
 */
export async function acquireLiveSessionToken(creds: IBKRCredentials): Promise<{ lst: string; expiration: number }> {
    const REALM_VALUE = "limited_poa";
    const { p, g } = parseDHParams(creds.dhParamPem);
    const dhRandomBytes = new Uint8Array(32);
    crypto.getRandomValues(dhRandomBytes);
    const dhRandom = BigInt("0x" + u8ToHex(dhRandomBytes));
    const dhChallenge = modPow(g, dhRandom, p).toString(16);
    const rawDecrypted = await rawRsaDecrypt(creds.accessTokenSecret, creds.encryptionKeyPem);
    let decryptOffset = 0;
    if (rawDecrypted[0] === 0x02) {
        decryptOffset = 1;
    } else if (rawDecrypted[0] === 0x00 && rawDecrypted[1] === 0x02) {
        decryptOffset = 2;
    } else {
        throw new Error("Invalid PKCS1v1.5 padding start");
    }
    const zeroIndex = rawDecrypted.indexOf(0, decryptOffset);
    if (zeroIndex === -1) throw new Error("Invalid PKCS1v1.5 padding: no zero separator");
    const prepend = u8ToHex(rawDecrypted.subarray(zeroIndex + 1));
    const lstParams: Record<string, string> = {
        oauth_consumer_key: creds.consumerKey,
        oauth_nonce: generateNonce(16),
        oauth_signature_method: "RSA-SHA256",
        oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
        oauth_token: creds.accessToken,
        diffie_hellman_challenge: dhChallenge,
    };
    const lstUrl = `https://api.ibkr.com/v1/api/oauth/live_session_token`;
    const lstSortedParams = Object.keys(lstParams).sort().map((k) => `${k}=${lstParams[k]}`).join("&");
    const lstBaseString = `${prepend}POST&${encodeURIComponent(lstUrl)}&${encodeURIComponent(lstSortedParams)}`;

    const signatureKeyDer = pemToDer(creds.signatureKeyPem);
    const signerKey = await crypto.subtle.importKey(
        "pkcs8", signatureKeyDer as unknown as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
    );
    const sigBuf = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signerKey, textEncode(lstBaseString) as unknown as BufferSource);
    lstParams.oauth_signature = u8ToB64(new Uint8Array(sigBuf));

    const lstAuthHeader = "OAuth " + Object.keys(lstParams).sort().map((k) => `${k}="${encodeURIComponent(lstParams[k])}"`).join(", ") + `, realm="${REALM_VALUE}"`;
    const lstResponse = await fetch(lstUrl, {
        method: "POST",
        headers: { Authorization: lstAuthHeader, "User-Agent": "ibkrwwwww" },
    });

    if (!lstResponse.ok) throw new Error(`LST Request failed: ${await lstResponse.text()}`);
    const lstData = await lstResponse.json() as any;

    const B = BigInt("0x" + lstData.diffie_hellman_response);
    const K = modPow(B, dhRandom, p);

    let hexK = K.toString(16);
    if (hexK.length % 2 !== 0) {
        hexK = "0" + hexK;
    }
    let kU8 = hexToU8(hexK);
    if (K.toString(2).length % 8 === 0) {
        const padded = new Uint8Array(kU8.length + 1);
        padded[0] = 0;
        padded.set(kU8, 1);
        kU8 = padded;
    }

    const computedLstU8 = await hmacSign("SHA-1", kU8, hexToU8(prepend));
    const computedLst = u8ToB64(computedLstU8);
    const lstBytes = b64ToU8(computedLst);
    const validationHmacU8 = await hmacSign("SHA-1", lstBytes, textEncode(creds.consumerKey));
    const calculatedSignature = u8ToHex(validationHmacU8);

    if (calculatedSignature !== lstData.live_session_token_signature) {
        throw new Error(`LST validation FAILED. Expected: ${lstData.live_session_token_signature}, Got: ${calculatedSignature}`);
    }
    return {
        lst: computedLst,
        expiration: parseInt(lstData.live_session_token_expiration, 10)
    };
}

const b64ToU8 = (b64: string): Uint8Array => {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
};

const u8ToB64 = (u8: Uint8Array): string => {
    let bin = "";
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    return btoa(bin);
};

const hexToU8 = (hex: string): Uint8Array => {
    if (hex.length % 2 !== 0) hex = "0" + hex;
    const u8 = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        u8[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return u8;
};

const u8ToHex = (u8: Uint8Array): string =>
    Array.from(u8)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

const b64urlToU8 = (b64url: string): Uint8Array =>
    b64ToU8(b64url.replace(/-/g, "+").replace(/_/g, "/"));

const textEncode = (text: string): Uint8Array => new TextEncoder().encode(text);

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
    if (modulus === 1n) return 0n;
    let result = 1n;
    base = base % modulus;
    while (exponent > 0n) {
        if (exponent % 2n === 1n) result = (result * base) % modulus;
        exponent = exponent / 2n;
        base = (base * base) % modulus;
    }
    return result;
}

function generateNonce(length: number = 16): string {
    const u8 = new Uint8Array(length);
    crypto.getRandomValues(u8);
    return u8ToHex(u8);
}

function pemToDer(pem: string): Uint8Array {
    const b64 = pem
        .replace(/-----BEGIN[^-]+-----/g, "")
        .replace(/-----END[^-]+-----/g, "")
        .replace(/\s/g, "");
    const der = b64ToU8(b64);

    if (pem.includes("BEGIN RSA PRIVATE KEY")) {
        const totalLen = 22 + der.length;
        const pkcs8Prefix = new Uint8Array([
            0x30, 0x82, totalLen >> 8, totalLen & 0xff,
            0x02, 0x01, 0x00,
            0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
            0x04, 0x82, der.length >> 8, der.length & 0xff,
        ]);
        const result = new Uint8Array(pkcs8Prefix.length + der.length);
        result.set(pkcs8Prefix);
        result.set(der, pkcs8Prefix.length);
        return result;
    }
    return der;
}

function parseDHParams(dhPem: string): { p: bigint; g: bigint } {
    const dhU8 = pemToDer(dhPem);
    let offset = 0;
    const readLen = () => {
        let len = dhU8[offset++];
        if (len & 0x80) {
            let count = len & 0x7f;
            len = 0;
            while (count--) len = (len << 8) | dhU8[offset++];
        }
        return len;
    };
    if (dhU8[offset++] !== 0x30) throw new Error("Invalid DH Param format");
    readLen();
    if (dhU8[offset++] !== 0x02) throw new Error("Invalid DH Param format (P)");
    const pLen = readLen();
    const p = BigInt("0x" + u8ToHex(dhU8.subarray(offset, offset + pLen)));
    offset += pLen;
    let g = 2n;
    if (offset < dhU8.length && dhU8[offset++] === 0x02) {
        const gLen = readLen();
        g = BigInt("0x" + u8ToHex(dhU8.subarray(offset, offset + gLen)));
    }
    return { p, g };
}
async function rawRsaDecrypt(ciphertextBase64: string, pem: string): Promise<Uint8Array> {
    const der = pemToDer(pem);
    const key = await crypto.subtle.importKey(
        "pkcs8",
        der.buffer as ArrayBuffer,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        true,
        ["sign"]
    );
    const jwk = await crypto.subtle.exportKey("jwk", key);

    if (!jwk.n || !jwk.d) throw new Error("Failed to extract RSA params via JWK");
    const n = BigInt("0x" + u8ToHex(b64urlToU8(jwk.n)));
    const d = BigInt("0x" + u8ToHex(b64urlToU8(jwk.d)));
    const c = BigInt("0x" + u8ToHex(b64ToU8(ciphertextBase64)));
    const m = modPow(c, d, n);
    let nHexLen = n.toString(16).length;
    if (nHexLen % 2 !== 0) nHexLen++;
    const mHex = m.toString(16).padStart(nHexLen, "0");
    return hexToU8(mHex);
}
async function hmacSign(hashType: "SHA-1" | "SHA-256", keyU8: Uint8Array, dataU8: Uint8Array): Promise<Uint8Array> {
    const cryptoKey = await crypto.subtle.importKey("raw", keyU8, { name: "HMAC", hash: hashType }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", cryptoKey, dataU8);
    return new Uint8Array(sig);
}

function rfc3986Encode(str: string) {
    return encodeURIComponent(str).replace(/[!'()*]/g, (c) =>
        `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    );
}

export async function getStandardAuthHeader(
    method: string,
    url: string,
    consumerKey: string,
    accessToken: string,
    lstBase64: string,
    realm: string = "limited_poa"
): Promise<string> {
    const oauthParams: Record<string, string> = {
        oauth_consumer_key: consumerKey,
        oauth_nonce: generateNonce(16),
        oauth_signature_method: "HMAC-SHA256",
        oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
        oauth_token: accessToken,
        oauth_version: "1.0"
    };
    const sortedKeys = Object.keys(oauthParams).sort();
    const encodedParams = sortedKeys
        .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(oauthParams[k])}`)
        .join("&");
    const baseString = `${method.toUpperCase()}&${rfc3986Encode(url)}&${rfc3986Encode(encodedParams)}`;
    const sigU8 = await hmacSign("SHA-256", b64ToU8(lstBase64), textEncode(baseString));
    const signatureBase64 = u8ToB64(sigU8);
    oauthParams.oauth_signature = rfc3986Encode(signatureBase64);
    return (
        "OAuth " +
        Object.keys(oauthParams)
            .sort()
            .map((k) => `${k}="${oauthParams[k]}"`)
            .join(", ") +
        `, realm="${rfc3986Encode(realm)}"`
    );
}