import { createMiddleware } from 'hono/factory'
import { basicAuth } from 'hono/basic-auth'
import { verify } from 'hono/jwt'

const errorCache: Record<string, { count: number; expiresAt: number }> = {};

export const authWithLimit = createMiddleware<{
    Bindings: { authUser: string; authPwd: string; JWT_SECRET: string }
}>(async (c, next) => {
    if (c.req.method === 'OPTIONS') {
        return await next();
    }
    const authHeader = c.req.header('Authorization');

    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
            const payload = await verify(token, c.env.JWT_SECRET, 'HS256');
            console.log("🟢JWT Token is valid ", payload.sub);
            return await next();
        } catch (err: any) {
            console.warn("JWT Token is invalid", err.message);
            c.status(401);
            return c.json({ success: false, message: '🔒 JWT Token is invalid' });
        }
    }
    // ================================================================
    const clientIP = c.req.header('CF-Connecting-IP') || 'anonymous';
    const now = Date.now();
    if (errorCache[clientIP]) {
        const record = errorCache[clientIP];

        if (now > record.expiresAt) {
            delete errorCache[clientIP];
        } else if (record.count >= 5) {
            c.status(429);
            return c.json({
                success: false,
                message: '429 - Your request has been verified too many times.'
            });
        }
    }

    // ================================================================
    const authHandler = basicAuth({
        username: 'user',
        password: 'pwd',
        verifyUser: async (username, password, ctx) => {
            const expectedUser = ctx.env.authUser;
            const expectedPass = ctx.env.authPwd;

            if (username === expectedUser && password === expectedPass) {
                delete errorCache[clientIP];
                return true;
            }

            if (!errorCache[clientIP]) {
                errorCache[clientIP] = { count: 1, expiresAt: now + 60 * 1000 };
            } else {
                errorCache[clientIP].count += 1;
                errorCache[clientIP].expiresAt = now + 60 * 1000;
            }

            return false;
        }
    });
    await authHandler(c, next);
});