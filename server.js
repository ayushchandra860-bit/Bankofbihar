const express = require("express");
const path = require("path");
const {
  initializeDatabase,
  createUserWithAccount,
  authenticateUser,
  getUserDashboard,
  createDeposit,
  createWithdrawal,
  getTransactionHistory,
  getAdminSummary,
  getAdminUsers,
} = require("./src/db");
const {
  createSession,
  getSession,
  deleteSession,
  sessionCookie,
  clearSessionCookie,
} = require("./src/sessionStore");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || "";
  return cookieHeader.split(";").reduce((cookies, segment) => {
    const [rawKey, ...rawValue] = segment.trim().split("=");
    if (!rawKey) {
      return cookies;
    }

    cookies[rawKey] = decodeURIComponent(rawValue.join("="));
    return cookies;
  }, {});
}

function attachCurrentUser(req, _res, next) {
  const cookies = parseCookies(req);
  const sessionId = cookies.bankOfBiharSession;

  if (sessionId) {
    const session = getSession(sessionId);
    if (session) {
      req.currentUser = session;
    }
  }

  next();
}

function requireAuth(req, res, next) {
  if (!req.currentUser) {
    return res.status(401).json({ error: "Please login to continue." });
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!req.currentUser || req.currentUser.role !== "admin") {
    return res.status(403).json({ error: "Admin access only." });
  }

  next();
}

app.use(attachCurrentUser);

app.get("/api/auth/session", async (req, res, next) => {
  if (!req.currentUser) {
    return res.json({ loggedIn: false });
  }

  try {
    const dashboard = await getUserDashboard(req.currentUser.userId);

    if (!dashboard) {
      deleteSession(req.currentUser.sessionId);
      res.setHeader("Set-Cookie", clearSessionCookie());
      return res.json({ loggedIn: false });
    }

    res.json({
      loggedIn: true,
      role: dashboard.user.role,
      user: dashboard.user,
      account: dashboard.account,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { fullName, email, mobile, password, accountType } = req.body;
    const user = await createUserWithAccount({
      fullName,
      email,
      mobile,
      password,
      accountType,
    });
    const sessionId = createSession({
      userId: user.id,
      role: user.role,
      name: user.fullName,
    });

    res.setHeader("Set-Cookie", sessionCookie(sessionId));
    res.status(201).json({
      message: "Registration successful.",
      role: user.role,
      user,
      account: user.account,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await authenticateUser(email, password);
    const sessionId = createSession({
      userId: user.id,
      role: user.role,
      name: user.fullName,
    });

    res.setHeader("Set-Cookie", sessionCookie(sessionId));
    res.json({
      message: "Login successful.",
      role: user.role,
      user,
      account: user.account,
    });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  deleteSession(req.currentUser.sessionId);
  res.setHeader("Set-Cookie", clearSessionCookie());
  res.json({ message: "Logged out successfully." });
});

app.get("/api/account/dashboard", requireAuth, async (req, res, next) => {
  try {
    const dashboard = await getUserDashboard(req.currentUser.userId);
    res.json(dashboard);
  } catch (error) {
    next(error);
  }
});

app.post("/api/account/deposit", requireAuth, async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const description = req.body.description;
    const result = await createDeposit(req.currentUser.userId, amount, description);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/account/withdraw", requireAuth, async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const description = req.body.description;
    const result = await createWithdrawal(req.currentUser.userId, amount, description);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/account/transactions", requireAuth, async (req, res, next) => {
  try {
    const transactions = await getTransactionHistory(req.currentUser.userId);
    res.json({ transactions });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/summary", requireAdmin, async (req, res, next) => {
  try {
    res.json(await getAdminSummary());
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/users", requireAdmin, async (req, res, next) => {
  try {
    res.json({ users: await getAdminUsers() });
  } catch (error) {
    next(error);
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return next();
  }

  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, req, res, _next) => {
  console.error(error);

  if (req.path.startsWith("/api/")) {
    res.status(500).json({ error: "Internal server error." });
    return;
  }

  res.status(500).send("Internal server error.");
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Bank Of Bihar server running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to start Bank Of Bihar:", error);
    process.exit(1);
  });
