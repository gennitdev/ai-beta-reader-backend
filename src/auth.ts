import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import axios from "axios";
import NodeCache from "node-cache";
import { Request, Response, NextFunction } from "express";
import { pool } from "./db.js";

// Types
interface AuthenticatedRequest extends Request {
  user?: {
    sub: string;
    email: string;
    email_verified: boolean;
    username?: string;
  };
}

interface CachedUserInfo {
  email: string | null;
}

// Cache response from Auth0 userinfo endpoint
const userInfoCache = new NodeCache({ stdTTL: 900 }); // Cache expires in 15 minutes

// Lazy initialization of the JWKS client
let client: any = null;

const getJwksClient = () => {
  if (!client) {
    if (!process.env.AUTH0_DOMAIN) {
      throw new Error("AUTH0_DOMAIN environment variable is not defined");
    }
    client = jwksClient({
      jwksUri: `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`,
    });
  }
  return client;
};

const getKey = (header: any, callback: any) => {
  if (!header || !header.kid) {
    return callback(new Error("Missing 'kid' in JWT header"), null);
  }

  try {
    const jwksClientInstance = getJwksClient();
    jwksClientInstance.getSigningKey(header.kid, (err: any, key: any) => {
      if (err) {
        console.error("Error retrieving signing key:", err);
        if (err.code === "ENOTFOUND") {
          console.error(
            `DNS resolution failed for domain: ${process.env.AUTH0_DOMAIN}`
          );
        }
        return callback(err, null);
      }
      const signingKey = key.getPublicKey();
      callback(null, signingKey);
    });
  } catch (error) {
    console.error("Error initializing JWKS client or retrieving key:", error);
    return callback(error, null);
  }
};

// Get user from database by Auth0 sub
export const getUserFromAuth0Sub = async (sub: string) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE auth0_sub = $1',
      [sub]
    );
    return rows[0] || null;
  } catch (error) {
    console.error("Error fetching user from database:", error);
    return null;
  }
};

// Create or update user in database
export const upsertUser = async (userData: {
  auth0_sub: string;
  email: string;
  email_verified: boolean;
  username?: string;
  name?: string;
}) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (auth0_sub, email, email_verified, username, name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())
       ON CONFLICT (auth0_sub) DO UPDATE SET
         email = EXCLUDED.email,
         email_verified = EXCLUDED.email_verified,
         username = EXCLUDED.username,
         name = EXCLUDED.name,
         updated_at = now()
       RETURNING *`,
      [userData.auth0_sub, userData.email, userData.email_verified, userData.username, userData.name]
    );
    return rows[0];
  } catch (error) {
    console.error("Error upserting user:", error);
    throw error;
  }
};

// JWT verification middleware
export const authenticateJWT = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const token = req.headers.authorization?.replace("Bearer ", "");

  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  if (!process.env.AUTH0_DOMAIN) {
    return res.status(500).json({ error: "AUTH0_DOMAIN not configured" });
  }

  try {
    const decoded: any = await new Promise((resolve, reject) => {
      jwt.verify(token, getKey, { algorithms: ["RS256"] }, (err, decoded) => {
        if (err) {
          console.error("JWT Verification Error:", err);
          if (err.name === 'TokenExpiredError') {
            reject(new Error("Your session has expired. Please sign in again."));
          } else {
            reject(new Error("Your authentication token is invalid. Please sign in again."));
          }
          return;
        }
        resolve(decoded);
      });
    });

    let email: string | null = null;
    const audience = decoded?.aud;

    if (audience === process.env.AUTH0_CLIENT_ID) {
      // UI-based token
      email = decoded?.email;
    } else if (
      Array.isArray(audience) &&
      audience.includes(`https://${process.env.AUTH0_DOMAIN}/api/v2/`)
    ) {
      // Programmatic token - get email from userinfo endpoint
      const cachedUserInfo: CachedUserInfo | undefined = userInfoCache.get(token);

      if (cachedUserInfo) {
        email = cachedUserInfo.email;
      } else {
        try {
          const userInfoResponse = await axios.get(
            `https://${process.env.AUTH0_DOMAIN}/userinfo`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
              },
            }
          );
          email = userInfoResponse?.data?.email;

          // Cache the userinfo response
          const userInfoToCache: CachedUserInfo = { email };
          userInfoCache.set(token, userInfoToCache);
        } catch (error) {
          console.error("Error fetching email from Auth0 userinfo:", error);
          return res.status(401).json({ error: "Failed to get user info" });
        }
      }
    } else {
      console.error("Token audience is unrecognized.");
      return res.status(401).json({ error: "Invalid token audience" });
    }

    // Set user data on request
    req.user = {
      sub: decoded.sub,
      email: email || "",
      email_verified: decoded.email_verified || false,
    };

    // Get or create user in database
    let dbUser = await getUserFromAuth0Sub(decoded.sub);
    if (!dbUser && email) {
      dbUser = await upsertUser({
        auth0_sub: decoded.sub,
        email,
        email_verified: decoded.email_verified || false,
        name: decoded.name,
        username: decoded.preferred_username || decoded.nickname
      });
    }

    if (dbUser) {
      req.user.username = dbUser.username;
    }

    next();
  } catch (error) {
    console.error("Authentication error:", error);
    res.status(401).json({ error: (error as Error).message });
  }
};

// Optional authentication middleware (doesn't fail if no token)
export const optionalAuth = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const token = req.headers.authorization?.replace("Bearer ", "");

  if (!token) {
    return next();
  }

  try {
    await authenticateJWT(req, res, next);
  } catch (error) {
    // Continue without authentication if token is invalid
    next();
  }
};

export type { AuthenticatedRequest };