const crypto = require("crypto");

const sessions = new Map();
const maxAgeMs = 12 * 60 * 60 * 1000;

function createSession({ userId, role, name }) {
  const sessionId = crypto.randomBytes(24).toString("hex");
  sessions.set(sessionId, {
    sessionId,
    userId,
    role,
    name,
    expiresAt: Date.now() + maxAgeMs,
  });
  return sessionId;
}

function getSession(sessionId) {
  const session = sessions.get(sessionId);

  if (!session) {
    return null;
  }

  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    return null;
  }

  return session;
}

function deleteSession(sessionId) {
  sessions.delete(sessionId);
}

function sessionCookie(sessionId) {
  return `bankOfBiharSession=${sessionId}; HttpOnly; Path=/; Max-Age=${maxAgeMs / 1000}; SameSite=Lax`;
}

function clearSessionCookie() {
  return "bankOfBiharSession=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax";
}

module.exports = {
  createSession,
  getSession,
  deleteSession,
  sessionCookie,
  clearSessionCookie,
};
