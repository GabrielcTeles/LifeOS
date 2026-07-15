import express from "express";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";

dotenv.config();

const app = express();
const PORT = 3000;
const DB_PATH = process.env.VERCEL === "1" ? "/tmp/db.json" : path.join(process.cwd(), "db.json");

app.use(express.json({ limit: "50mb" }));

// Initialize Gemini Client safely
let ai: GoogleGenAI | null = null;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const hasValidKey = GEMINI_API_KEY && 
                     GEMINI_API_KEY !== "undefined" && 
                     GEMINI_API_KEY !== "null" && 
                     GEMINI_API_KEY.trim() !== "";

if (hasValidKey) {
  try {
    ai = new GoogleGenAI({
      apiKey: GEMINI_API_KEY,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
    console.log("Gemini AI Client successfully initialized.");
  } catch (error) {
    console.error("Error initializing Gemini AI Client:", error);
  }
} else {
  console.log("GEMINI_API_KEY not found or invalid in environment. Scanning receipt will run in mock mode.");
}

// Seeding Default Mock Data if db.json doesn't exist
const initialData = {
  profile: {
    name: "",
    email: "",
    currency: "BRL" as const,
    theme: "light" as const
  },
  transactions: [],
  investments: [],
  fixedIncome: [],
  budgets: {
    "Alimentação": 0,
    "Transporte": 0,
    "Saúde": 0,
    "Educação": 0,
    "Lazer": 0,
    "Utilities": 0,
    "Outros": 0
  },
  bankAccounts: []
};

function readDb() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      const defaultDb = {
        users: {
          "gabrielctelless@outlook.com": {
            name: "Gabriel Telles",
            password: "admin",
            data: initialData
          }
        }
      };
      fs.writeFileSync(DB_PATH, JSON.stringify(defaultDb, null, 2), "utf8");
      return defaultDb;
    }
    const data = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(data);
    if (!parsed || !parsed.users) {
      // Migrate old format to multi-user format
      const migrated = {
        users: {
          "gabrielctelless@outlook.com": {
            name: parsed?.profile?.name || "Gabriel Telles",
            password: "admin",
            data: parsed || initialData
          }
        }
      };
      fs.writeFileSync(DB_PATH, JSON.stringify(migrated, null, 2), "utf8");
      return migrated;
    }
    return parsed;
  } catch (error) {
    console.error("Error reading database:", error);
    return {
      users: {
        "gabrielctelless@outlook.com": {
          name: "Gabriel Telles",
          password: "admin",
          data: initialData
        }
      }
    };
  }
}

function writeDb(data: any) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    console.error("Error writing database:", error);
  }
}

function getUserEmail(req: express.Request): string {
  const rawEmail = req.headers["x-user-email"] || req.query.email || req.body.email || "gabrielctelless@outlook.com";
  return String(rawEmail).toLowerCase().trim();
}

function readUserDb(email: string) {
  const db = readDb();
  const user = db.users[email];
  if (user) {
    return user.data;
  }
  // Safe seed if user requested but didn't exist in master DB (e.g. registered via local fallback first)
  const userData = {
    ...initialData,
    profile: {
      ...initialData.profile,
      email: email,
      name: email.split("@")[0].replace(/[._-]/g, " ")
    }
  };
  db.users[email] = {
    name: userData.profile.name,
    password: "admin", // default fallback
    data: userData
  };
  writeDb(db);
  return userData;
}

function writeUserDb(email: string, userData: any) {
  const db = readDb();
  if (!db.users[email]) {
    db.users[email] = {
      name: userData.profile?.name || email.split("@")[0],
      password: "admin",
      data: userData
    };
  } else {
    db.users[email].data = userData;
  }
  writeDb(db);
}

// Simulated real-time quotes with slight fluctuations (random walk)
type UserInvestment = {
  ticker: string;
  name?: string;
  type: 'Ações' | 'ETFs' | 'Cripto';
  currency: 'BRL' | 'USD' | 'EUR';
  sector?: string;
};

type CachedQuote = {
  price: number;
  change24h: number;
  updatedAt: number;
};

const quoteCache = new Map<string, CachedQuote>();
const QUOTE_CACHE_TTL = 60 * 1000;

function getYahooSymbol(investment: UserInvestment): string {
  const ticker = investment.ticker
    .toUpperCase()
    .trim()
    .replace(/\s+/g, '');

  if (!ticker) {
    throw new Error("Ticker não informado.");
  }

  // Permite ticker completo informado pelo usuário
  if (
    ticker.endsWith(".SA") ||
    ticker.endsWith(".L") ||
    ticker.endsWith(".TO") ||
    ticker.endsWith(".F") ||
    ticker.includes("-") ||
    ticker.includes("=")
  ) {
    return ticker;
  }

  // Criptomoedas cotadas em dólar
  if (investment.type === "Cripto") {
    return `${ticker}-USD`;
  }

  // Ativos brasileiros: ações, FIIs, ETFs, BDRs e Units
  if (investment.currency === "BRL") {
    return `${ticker}.SA`;
  }

  // Ações americanas
  return ticker;
}

async function fetchUsdBrl(): Promise<number> {
  const response = await fetch(
    "https://query2.finance.yahoo.com/v8/finance/chart/USDBRL=X?interval=1d&range=1d",
    {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Falha ao consultar dólar: HTTP ${response.status}`);
  }

  const json: any = await response.json();
  const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;

  if (!Number.isFinite(price)) {
    throw new Error("Cotação do dólar indisponível.");
  }

  return Number(price);
}

async function fetchInvestmentQuote(
  investment: UserInvestment,
  usdBrl: number
) {
  const ticker = investment.ticker.toUpperCase().trim();
  const yahooSymbol = getYahooSymbol(investment);
  const cacheKey = `${yahooSymbol}:${investment.currency}`;

  const cached = quoteCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.updatedAt < QUOTE_CACHE_TTL
  ) {
    return {
      ticker,
      price: cached.price,
      change24h: cached.change24h,
      name: investment.name || ticker,
      sector: investment.sector || "Outros",
      updatedAt: new Date(cached.updatedAt).toISOString(),
      isLive: true
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const url =
      `https://query2.finance.yahoo.com/v8/finance/chart/` +
      `${encodeURIComponent(yahooSymbol)}?interval=1d&range=5d`;

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!response.ok) {
      throw new Error(
        `Ativo ${ticker} não encontrado: HTTP ${response.status}`
      );
    }

    const json: any = await response.json();
    const result = json?.chart?.result?.[0];
    const apiError = json?.chart?.error;

    if (apiError || !result?.meta) {
      throw new Error(
        apiError?.description || `Cotação de ${ticker} indisponível`
      );
    }

    const meta = result.meta;
    let price = Number(meta.regularMarketPrice);
    const previousClose = Number(
      meta.chartPreviousClose || meta.previousClose
    );

    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Preço inválido para ${ticker}`);
    }

    // Criptomoeda vem em USD; converte para BRL quando necessário
    if (
      investment.type === "Cripto" &&
      investment.currency === "BRL"
    ) {
      price *= usdBrl;
    }

    let change24h = Number(meta.regularMarketChangePercent);

    if (
      !Number.isFinite(change24h) &&
      Number.isFinite(previousClose) &&
      previousClose > 0
    ) {
      change24h = ((Number(meta.regularMarketPrice) - previousClose)
        / previousClose) * 100;
    }

    if (!Number.isFinite(change24h)) {
      change24h = 0;
    }

    const updatedAt = Date.now();
    const normalizedPrice = Number(price.toFixed(2));
    const normalizedChange = Number(change24h.toFixed(2));

    quoteCache.set(cacheKey, {
      price: normalizedPrice,
      change24h: normalizedChange,
      updatedAt
    });

    return {
      ticker,
      price: normalizedPrice,
      change24h: normalizedChange,
      name: meta.longName || meta.shortName || investment.name || ticker,
      sector: investment.sector || "Outros",
      updatedAt: new Date(updatedAt).toISOString(),
      isLive: true
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

app.get(
  ["/api/market/quotes", "/market/quotes"],
  async (req, res) => {
    const email = String(req.headers["x-user-email"] || "")
      .trim()
      .toLowerCase();

    if (!email) {
      return res.status(400).json({
        error: "Cabeçalho x-user-email não informado."
      });
    }

    const db = readDb();
    const user = db.users?.[email];

    if (!user) {
      return res.status(404).json({
        error: "Usuário não encontrado."
      });
    }

    const investments: UserInvestment[] =
      user.data?.investments || [];

    if (investments.length === 0) {
      return res.json([]);
    }

    let usdBrl = 1;

    try {
      usdBrl = await fetchUsdBrl();
    } catch (error) {
      console.error("Erro ao consultar USD/BRL:", error);
    }

    const uniqueInvestments = Array.from(
      new Map(
        investments.map(investment => [
          `${investment.ticker}:${investment.currency}`,
          investment
        ])
      ).values()
    );

    const results = await Promise.allSettled(
      uniqueInvestments.map(investment =>
        fetchInvestmentQuote(investment, usdBrl)
      )
    );

    const quotes = results
      .filter(
        (result): result is PromiseFulfilledResult<any> =>
          result.status === "fulfilled"
      )
      .map(result => result.value);

    const errors = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected"
      )
      .map(result =>
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason)
      );

    return res.json({
      quotes,
      errors,
      usdBrl,
      updatedAt: new Date().toISOString()
    });
  }
);

// Cache and live update logic for Banco Central do Brasil rates
let cachedRates = {
  CDI: 14.15,
  SELIC: 14.25,
  IPCA: 4.64,
  Poupança: 6.17,
  lastUpdated: 0
};

const RATES_CACHE_TTL = 10 * 60 * 1000; // 10 minutes cache

async function updateRatesFromBCB() {
  const now = Date.now();
  if (now - cachedRates.lastUpdated < RATES_CACHE_TTL) {
    return cachedRates;
  }

  try {
    // 1. Fetch Selic Meta (series 432) from Banco Central do Brasil SGS API
    // Since 432 is a daily series, we MUST specify a date window to avoid the 10-year limit error.
    // Let's query from 30 days ago to today.
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const day = String(thirtyDaysAgo.getDate()).padStart(2, '0');
    const month = String(thirtyDaysAgo.getMonth() + 1).padStart(2, '0');
    const year = thirtyDaysAgo.getFullYear();
    const dateStr = `${day}/${month}/${year}`;

    const selicUrl = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.432/dados?formato=json&dataInicial=${dateStr}`;
    const selicRes = await fetch(selicUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });
    if (selicRes.ok) {
      const data: any = await selicRes.json();
      if (Array.isArray(data) && data.length > 0) {
        const lastItem = data[data.length - 1];
        const val = parseFloat(lastItem.valor);
        if (!isNaN(val) && val > 0) {
          cachedRates.SELIC = val;
          cachedRates.CDI = Number((val - 0.10).toFixed(2));
          // Calculate Poupança based on Selic rule
          if (val > 8.5) {
            cachedRates.Poupança = 6.17;
          } else {
            cachedRates.Poupança = Number((val * 0.7).toFixed(2));
          }
        }
      }
    }

    // 2. Fetch IPCA accumulated in 12 months (series 13522)
    const ipcaUrl = "https://api.bcb.gov.br/dados/serie/bcdata.sgs.13522/dados?formato=json";
    const ipcaRes = await fetch(ipcaUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });
    if (ipcaRes.ok) {
      const data: any = await ipcaRes.json();
      if (Array.isArray(data) && data.length > 0) {
        const lastItem = data[data.length - 1];
        const val = parseFloat(lastItem.valor);
        if (!isNaN(val) && val > 0) {
          cachedRates.IPCA = val;
        }
      }
    }

    cachedRates.lastUpdated = now;
    console.log("Rates updated successfully from Banco Central do Brasil:", cachedRates);
  } catch (error) {
    console.error("Error updating rates from Banco Central do Brasil:", error);
  }

  return cachedRates;
}

// --- ECONOMIC RATES & CACHING ---
// Returns economic reference rates for fixed income (SELIC, CDI, IPCA)
app.get(["/api/fixed-income/rates", "/fixed-income/rates"], async (req, res) => {
  const rates = await updateRatesFromBCB();
  res.json({
    CDI: rates.CDI,
    SELIC: rates.SELIC,
    IPCA: rates.IPCA,
    Poupança: rates.Poupança
  });
});

// --- SUPABASE DIRECT INTEGRATION HELPERS ---

function getSupabaseCredentials(req: express.Request) {
  const url = req.headers["x-supabase-url"] || req.query.supabase_url || req.body.supabase_url || "";
  const key = req.headers["x-supabase-key"] || req.query.supabase_key || req.body.supabase_key || "";
  
  const cleanUrl = String(url).trim();
  const cleanKey = String(key).trim();
  
  const isPlaceholderUrl = cleanUrl.includes("seu-projeto.supabase.co") || !cleanUrl;
  const isPlaceholderKey = cleanKey.includes("sua-anon-key-aqui") || !cleanKey;
  
  if (isPlaceholderUrl || isPlaceholderKey) {
    return null;
  }
  return { url: cleanUrl.replace(/\/$/, ""), key: cleanKey };
}

async function querySupabase(url: string, key: string, path: string, method: string = "GET", body?: any) {
  const targetUrl = `${url}/rest/v1/${path}`;
  const headers: Record<string, string> = {
    "apikey": key,
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json"
  };
  
  if (method === "POST") {
    headers["Prefer"] = "return=representation";
  }
  
  const options: RequestInit = {
    method,
    headers
  };
  
  if (body && (method === "POST" || method === "PATCH" || method === "PUT")) {
    options.body = JSON.stringify(body);
  }
  
  const res = await fetch(targetUrl, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase Error (${res.status}): ${text}`);
  }
  return res.json().catch(() => ({}));
}

// --- AUTHENTICATION API ENDPOINTS ---

// Register
app.post("/api/auth/register", async (req, res) => {
  let body = req.body || {};
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) {}
  }
  const { name, email, password, currency } = body;
  if (!email || !password || !name) {
    return res.status(400).json({ success: false, error: "Nome, e-mail e senha são obrigatórios." });
  }

  const cleanEmail = String(email).toLowerCase().trim();

  // Generate template AppData for this new user
  const initialUserData = {
    profile: {
      name,
      email: cleanEmail,
      currency: currency || "BRL",
      theme: "light",
    },
    transactions: [
      {
        id: "t-welcome",
        date: new Date().toISOString().split('T')[0],
        amount: 5000.0,
        type: "receita",
        category: "Salário",
        subcategory: "Mensal",
        description: "Saldo Inicial de Boas-Vindas",
        currency: currency || "BRL",
        tags: ["inicial"]
      }
    ],
    investments: [],
    fixedIncome: [],
    budgets: {
      "Alimentação": 1200,
      "Transporte": 400,
      "Saúde": 300,
      "Educação": 500,
      "Lazer": 600,
      "Utilities": 500,
      "Outros": 400
    },
    bankAccounts: []
  };

  const sb = getSupabaseCredentials(req);
  if (sb) {
    try {
      // 1. Check if user already exists in user_accounts
      const existing = await querySupabase(sb.url, sb.key, `user_accounts?email=eq.${encodeURIComponent(cleanEmail)}`);
      if (existing && existing.length > 0) {
        return res.status(400).json({ success: false, error: "Este e-mail já está cadastrado no Supabase." });
      }

      // 2. Insert user into user_accounts
      await querySupabase(sb.url, sb.key, "user_accounts", "POST", {
        email: cleanEmail,
        name,
        password,
        currency: currency || "BRL"
      });

      // 3. Create profile document
      await querySupabase(sb.url, sb.key, "user_profiles", "POST", {
        email: cleanEmail,
        data: initialUserData
      });

      return res.json({
        success: true,
        user: { name, email: cleanEmail, currency: currency || "BRL" },
        data: initialUserData
      });
    } catch (err: any) {
      console.error("Supabase Register error:", err);
      return res.status(500).json({ success: false, error: `Erro no Supabase: ${err.message}. Certifique-se de que criou as tabelas 'user_accounts' e 'user_profiles' no seu painel SQL.` });
    }
  }

  // Fallback to local file-based database
  const db = readDb();
  if (db.users[cleanEmail]) {
    return res.status(400).json({ success: false, error: "Este e-mail já está cadastrado." });
  }

  db.users[cleanEmail] = {
    name,
    password,
    data: initialUserData
  };
  
  writeDb(db);

  res.json({ 
    success: true, 
    user: { name, email: cleanEmail, currency: currency || "BRL" }, 
    data: initialUserData 
  });
});

// Login
app.post("/api/auth/login", async (req, res) => {
  let body = req.body || {};
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) {}
  }
  const { email, password } = body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: "E-mail e senha são obrigatórios." });
  }

  const cleanEmail = String(email).toLowerCase().trim();

  const sb = getSupabaseCredentials(req);
  if (sb) {
    try {
      const existing = await querySupabase(sb.url, sb.key, `user_accounts?email=eq.${encodeURIComponent(cleanEmail)}`);
      if (!existing || existing.length === 0) {
        return res.status(401).json({ success: false, error: "E-mail ou senha incorretos." });
      }
      const user = existing[0];
      if (user.password !== password) {
        return res.status(401).json({ success: false, error: "E-mail ou senha incorretos." });
      }

      // Fetch user profile
      const profileRes = await querySupabase(sb.url, sb.key, `user_profiles?email=eq.${encodeURIComponent(cleanEmail)}`);
      let userData = profileRes && profileRes.length > 0 ? profileRes[0].data : null;

      if (!userData) {
        // Create fallback profile
        userData = {
          profile: {
            name: user.name,
            email: cleanEmail,
            currency: user.currency || "BRL",
            theme: "light",
          },
          transactions: [],
          investments: [],
          fixedIncome: [],
          budgets: {
            "Alimentação": 1200,
            "Transporte": 400,
            "Saúde": 300,
            "Educação": 500,
            "Lazer": 600,
            "Utilities": 500,
            "Outros": 400
          },
          bankAccounts: []
        };
        await querySupabase(sb.url, sb.key, "user_profiles", "POST", {
          email: cleanEmail,
          data: userData
        });
      }

      return res.json({
        success: true,
        user: { name: user.name, email: cleanEmail, currency: user.currency || "BRL" },
        data: userData
      });
    } catch (err: any) {
      console.error("Supabase Login error:", err);
      return res.status(500).json({ success: false, error: `Erro no login via Supabase: ${err.message}. Verifique suas credenciais e tabelas.` });
    }
  }

  // Fallback to local DB
  const db = readDb();
  const user = db.users[cleanEmail];

  if (!user || user.password !== password) {
    return res.status(401).json({ success: false, error: "E-mail ou senha incorretos." });
  }

  res.json({ 
    success: true, 
    user: { name: user.name, email: cleanEmail, currency: user.data?.profile?.currency || "BRL" }, 
    data: user.data 
  });
});

// Full state synchronization per user
app.get(["/api/data", "/data"], async (req, res) => {
  const email = getUserEmail(req);
  const sb = getSupabaseCredentials(req);
  if (sb) {
    try {
      const profileRes = await querySupabase(sb.url, sb.key, `user_profiles?email=eq.${encodeURIComponent(email)}`);
      if (profileRes && profileRes.length > 0) {
        return res.json(profileRes[0].data);
      }
      const freshData = {
        profile: { name: email.split("@")[0], email, currency: "BRL", theme: "light" },
        transactions: [],
        investments: [],
        fixedIncome: [],
        budgets: {},
        bankAccounts: []
      };
      return res.json(freshData);
    } catch (err: any) {
      console.error("Supabase GET data error:", err);
      return res.status(500).json({ error: `Erro ao buscar dados do Supabase: ${err.message}` });
    }
  }

  res.json(readUserDb(email));
});

app.post(["/api/data", "/data"], async (req, res) => {
  const email = getUserEmail(req);
  let data = req.body;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch (e) {}
  }

  const sb = getSupabaseCredentials(req);
  if (sb) {
    try {
      // Ensure user account exists in user_accounts first (prevents Foreign Key violations on user_profiles)
      try {
        const existingAccounts = await querySupabase(sb.url, sb.key, `user_accounts?email=eq.${encodeURIComponent(email)}`);
        if (!existingAccounts || existingAccounts.length === 0) {
          const displayName = data?.profile?.name || email.split("@")[0].replace(/[._-]/g, " ");
          await querySupabase(sb.url, sb.key, "user_accounts", "POST", {
            email,
            name: displayName,
            password: "admin", // default login fallback password
            currency: data?.profile?.currency || "BRL"
          });
          console.log(`[Supabase Auto-Sync] Automatically created user_accounts entry for ${email}`);
        }
      } catch (authErr: any) {
        console.warn("[Supabase Auto-Sync] Could not check/insert user_accounts:", authErr.message);
      }

      const profileRes = await querySupabase(sb.url, sb.key, `user_profiles?email=eq.${encodeURIComponent(email)}`);
      if (profileRes && profileRes.length > 0) {
        await querySupabase(sb.url, sb.key, `user_profiles?email=eq.${encodeURIComponent(email)}`, "PATCH", {
          data
        });
      } else {
        await querySupabase(sb.url, sb.key, "user_profiles", "POST", {
          email,
          data
        });
      }
      return res.json({ success: true, data });
    } catch (err: any) {
      console.error("Supabase POST data error:", err);
      return res.status(500).json({ success: false, error: `Erro ao salvar dados no Supabase: ${err.message}` });
    }
  }

  writeUserDb(email, data);
  res.json({ success: true, data });
});

const cleanEnvVar = (val: string | undefined): string | undefined => {
  if (!val) return undefined;
  let s = val.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
  }
  if (s.startsWith("'") && s.endsWith("'")) {
    s = s.slice(1, -1);
  }
  return s.trim();
};

// OpenFinance mock synchronization flow
app.post(["/api/openfinance/sync", "/openfinance/sync"], (req, res) => {
  const email = getUserEmail(req);
  const db = readUserDb(email);
  let body = req.body || {};
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) {}
  }
  const bankName = body.bankName;

  // Let's create mock new transactions for OpenFinance sync
  const possibleTransactions = [
    { description: "Pão de Açúcar Supermercados", amount: 145.20, category: "Alimentação", subcategory: "Supermercado" },
    { description: "Posto Shell Aliança", amount: 180.00, category: "Transporte", subcategory: "Combustível" },
    { description: "Netflix Assinatura", amount: 55.90, category: "Lazer", subcategory: "Streaming" },
    { description: "Fármacia Pague Menos", amount: 35.40, category: "Saúde", subcategory: "Medicamentos" },
    { description: "Sabesp S.A. Água", amount: 84.50, category: "Utilities", subcategory: "Saneamento" }
  ];

  // Pick 1 or 2 random transactions to add
  const count = Math.floor(Math.random() * 2) + 1;
  const added: any[] = [];
  const today = new Date().toISOString().split("T")[0];

  for (let i = 0; i < count; i++) {
    const item = possibleTransactions[Math.floor(Math.random() * possibleTransactions.length)];
    const id = "of-" + Math.random().toString(36).substr(2, 9);
    
    // Deduplicate: check if we already added a transaction with the same description today
    const exists = db.transactions.some((t: any) => t.description === item.description && t.date === today);
    if (!exists) {
      const newTx = {
        id,
        date: today,
        amount: item.amount,
        type: "despesa" as const,
        category: item.category,
        subcategory: item.subcategory,
        description: item.description,
        currency: "BRL" as const,
        tags: ["OpenFinance", bankName],
        bankAccount: bankName
      };
      db.transactions.unshift(newTx);
      added.push(newTx);

      // Deduct from bank account balance
      const account = db.bankAccounts.find((a: any) => a.bankName === bankName);
      if (account) {
        account.balance = Number((account.balance - item.amount).toFixed(2));
        account.lastSync = new Date().toISOString();
      }
    }
  }

  writeUserDb(email, db);
  res.json({ success: true, addedCount: added.length, addedTransactions: added, fullAccounts: db.bankAccounts });
});

// Add a transaction
app.post(["/api/transactions", "/transactions"], (req, res) => {
  const email = getUserEmail(req);
  const db = readUserDb(email);
  let body = req.body || {};
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) {}
  }
  const transaction = {
    id: "t-" + Math.random().toString(36).substr(2, 9),
    ...body,
  };
  db.transactions.unshift(transaction);
  writeUserDb(email, db);
  res.json({ success: true, transaction });
});

// Secure Supabase Proxy / Simulated Sandbox to bypass browser-level CORS / DNS failures
app.all(["/api/supabase/proxy", "/supabase/proxy"], async (req, res) => {
  let requestData = req.body;
  if (typeof requestData === "string") {
    try {
      requestData = JSON.parse(requestData);
    } catch (e) {
      // ignore
    }
  }
  requestData = requestData || {};
  const { url, apiKey, tableName, method, body, id, idFieldName } = requestData;

  if (!url || !apiKey || !tableName || !method) {
    return res.status(400).json({ 
      error: "Parâmetros obrigatórios ausentes no proxy.", 
      details: "Requer url, apiKey, tableName e method." 
    });
  }

  const isPlaceholderUrl = url.includes("seu-projeto.supabase.co");
  const isPlaceholderKey = apiKey.includes("sua-anon-key-aqui");
  const isSimulated = isPlaceholderUrl || isPlaceholderKey || !url || !apiKey;

  if (isSimulated) {
    console.log(`[Supabase Sandbox] Simulating ${method} on table "${tableName}"`);
    const email = getUserEmail(req);
    const db = readUserDb(email);
    if (!db.supabase_simulated_tables) {
      db.supabase_simulated_tables = {};
    }
    if (!db.supabase_simulated_tables[tableName]) {
      // Seed default sandbox data if the table is requested for the first time
      db.supabase_simulated_tables[tableName] = [
        { id: "1", descricao: "Almoço Executivo", valor: 38.50, categoria: "Alimentação", tags: ["sandbox", "teste"] },
        { id: "2", descricao: "Uber para Escritório", valor: 24.90, categoria: "Transporte", tags: ["sandbox"] },
        { id: "3", descricao: "Assinatura Netflix", valor: 55.90, category: "Lazer", tags: ["mensal"] }
      ];
      writeUserDb(email, db);
    }

    const tableData = db.supabase_simulated_tables[tableName];

    if (method === "GET") {
      return res.json(tableData);
    } else if (method === "POST") {
      const fieldName = idFieldName || "id";
      const newRecord = {
        [fieldName]: "sb-" + Math.random().toString(36).substr(2, 9),
        ...body,
        created_at: new Date().toISOString()
      };
      tableData.push(newRecord);
      db.supabase_simulated_tables[tableName] = tableData;
      writeUserDb(email, db);
      return res.json([newRecord]);
    } else if (method === "DELETE") {
      const initialLength = tableData.length;
      const fieldName = idFieldName || "id";
      db.supabase_simulated_tables[tableName] = tableData.filter(
        (row: any) => String(row[fieldName]) !== String(id)
      );
      writeUserDb(email, db);
      return res.json({ 
        success: true, 
        message: "Deletado com sucesso do sandbox persistido localmente.", 
        deletedCount: initialLength - db.supabase_simulated_tables[tableName].length 
      });
    }

    return res.status(400).json({ error: `Método ${method} não suportado no sandbox.` });
  }

  // Live Proxy Connection
  try {
    const cleanUrl = url.replace(/\/$/, "");
    let targetUrl = `${cleanUrl}/rest/v1/${tableName}`;
    
    const headers: Record<string, string> = {
      "apikey": apiKey,
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    };

    if (method === "GET") {
      targetUrl += "?select=*";
    } else if (method === "POST") {
      headers["Prefer"] = "return=representation";
    } else if (method === "DELETE") {
      const field = idFieldName || "id";
      targetUrl += `?${field}=eq.${id}`;
    }

    const fetchOptions: RequestInit = {
      method: method,
      headers: headers
    };

    if (method === "POST" && body) {
      const idField = idFieldName || "id";
      
      const sanitizeRow = (row: any) => {
        if (!row || typeof row !== "object") return row;
        
        // Detect schema based on column presence
        if ("ticker" in row) {
          // Investment
          const allowed = [idField, "ticker", "name", "type", "quantity", "purchasePrice", "purchaseDate", "sector", "currency"];
          const clean: any = {};
          allowed.forEach(k => {
            if (k === idField && row.id !== undefined && row[idField] === undefined) {
              clean[idField] = row.id;
            } else if (row[k] !== undefined) {
              clean[k] = row[k];
            }
          });
          return clean;
        }
        
        if ("indexation" in row || "maturityDate" in row) {
          // Fixed Income
          const allowed = [idField, "type", "value", "rate", "indexation", "applicationDate", "maturityDate", "liquidity"];
          const clean: any = {};
          allowed.forEach(k => {
            if (k === idField && row.id !== undefined && row[idField] === undefined) {
              clean[idField] = row.id;
            } else if (row[k] !== undefined) {
              clean[k] = row[k];
            }
          });
          return clean;
        }
        
        if ("amount" in row || "type" in row || "category" in row) {
          // Transaction
          const allowed = [idField, "date", "amount", "type", "category", "subcategory", "description", "currency", "tags"];
          const clean: any = {};
          allowed.forEach(k => {
            if (k === idField && row.id !== undefined && row[idField] === undefined) {
              clean[idField] = row.id;
            } else if (row[k] !== undefined) {
              clean[k] = row[k];
            }
          });
          return clean;
        }
        
        return row;
      };

      const sanitizedBody = Array.isArray(body) ? body.map(sanitizeRow) : sanitizeRow(body);
      fetchOptions.body = JSON.stringify(sanitizedBody);
    }

    console.log(`[Supabase Proxy] Requesting real endpoint: ${method} ${targetUrl}`);
    const targetResponse = await fetch(targetUrl, fetchOptions);

    if (!targetResponse.ok) {
      const errText = await targetResponse.text();
      return res.status(targetResponse.status).json({
        error: `Supabase REST API Error (Status ${targetResponse.status})`,
        details: errText
      });
    }

    const responseText = await targetResponse.text();
    let responseData = {};
    if (responseText) {
      try {
        responseData = JSON.parse(responseText);
      } catch (e) {
        responseData = { message: responseText };
      }
    }

    return res.json(responseData);
  } catch (err: any) {
    console.error("[Supabase Proxy] Connection failure:", err);
    return res.status(500).json({
      error: "Falha de conexão com o Supabase através do servidor.",
      details: err.message || "Verifique se o seu projeto do Supabase está ativo e as credenciais estão corretas."
    });
  }
});

// Receipt OCR Analysis with Gemini AI
app.post(["/api/transactions/scan", "/transactions/scan"], async (req, res) => {
  let requestData = req.body || {};

  if (typeof requestData === "string") {
    try {
      requestData = JSON.parse(requestData);
    } catch {
      return res.status(400).json({
        success: false,
        error: "Corpo da requisição inválido."
      });
    }
  }

  const { imageBase64, mimeType } = requestData;

  if (!imageBase64 || !mimeType) {
    return res.status(400).json({
      success: false,
      error: "Parâmetros 'imageBase64' e 'mimeType' são obrigatórios."
    });
  }

  if (!ai) {
    return res.status(503).json({
      success: false,
      error: "GEMINI_API_KEY não configurada ou cliente Gemini não inicializado."
    });
  }

  const allowedMimeTypes = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp"
  ];

  if (!allowedMimeTypes.includes(String(mimeType).toLowerCase())) {
    return res.status(400).json({
      success: false,
      error: `Formato de imagem não suportado: ${mimeType}`
    });
  }

  const rawBase64 = String(imageBase64).includes(";base64,")
    ? String(imageBase64).split(";base64,")[1]
    : String(imageBase64);

  if (!rawBase64 || rawBase64.length < 100) {
    return res.status(400).json({
      success: false,
      error: "Imagem inválida ou vazia."
    });
  }

  try {
    const prompt = `
Você é um sistema de OCR especializado em notas fiscais, cupons fiscais e recibos brasileiros.

Analise somente as informações realmente visíveis na imagem.

REGRAS OBRIGATÓRIAS:

1. Não invente nenhuma informação.
2. Não complete campos por suposição.
3. Quando uma informação textual não estiver legível, retorne uma string vazia.
4. Quando o valor total não estiver legível, retorne 0.
5. Não confunda subtotal, desconto, troco, valor recebido, tributos ou valor de item com o total final.
6. O campo "total" deve conter somente o valor final efetivamente pago.
7. Copie o nome do estabelecimento conforme aparece na imagem.
8. O CNPJ deve conter somente números.
9. A data deve estar no formato YYYY-MM-DD.
10. O horário deve estar no formato HH:mm.
11. Inclua em "items" somente produtos ou serviços realmente legíveis.
12. Use ponto como separador decimal.
13. Retorne somente JSON, sem texto antes ou depois.
14. Se a imagem estiver cortada, desfocada ou ilegível, informe isso em "warnings" e reduza a confiança.
15. Nunca use dados de exemplos ou respostas anteriores.

Campos esperados:

- establishment
- cnpj
- date
- time
- total
- paymentMethod
- category
- subcategory
- items
- confidence
- description
- warnings

A categoria deve ser uma destas:
Alimentação, Transporte, Saúde, Educação, Lazer, Utilities ou Outros.
`;

    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite-preview",
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: String(mimeType).toLowerCase(),
              data: rawBase64
            }
          },
          {
            text: prompt
          }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            establishment: {
              type: Type.STRING,
              description: "Nome do estabelecimento exatamente como visível."
            },
            cnpj: {
              type: Type.STRING,
              description: "CNPJ somente com números ou string vazia."
            },
            date: {
              type: Type.STRING,
              description: "Data no formato YYYY-MM-DD ou string vazia."
            },
            time: {
              type: Type.STRING,
              description: "Horário no formato HH:mm ou string vazia."
            },
            total: {
              type: Type.NUMBER,
              description: "Valor total final pago ou 0."
            },
            paymentMethod: {
              type: Type.STRING,
              description: "Forma de pagamento ou string vazia."
            },
            category: {
              type: Type.STRING,
              enum: [
                "Alimentação",
                "Transporte",
                "Saúde",
                "Educação",
                "Lazer",
                "Utilities",
                "Outros"
              ]
            },
            subcategory: {
              type: Type.STRING,
              description: "Subcategoria ou string vazia."
            },
            items: {
              type: Type.ARRAY,
              items: {
                type: Type.STRING
              },
              description: "Lista somente com itens legíveis."
            },
            confidence: {
              type: Type.INTEGER,
              description: "Confiança geral entre 0 e 100."
            },
            description: {
              type: Type.STRING,
              description: "Resumo curto baseado somente na imagem."
            },
            warnings: {
              type: Type.ARRAY,
              items: {
                type: Type.STRING
              },
              description: "Problemas encontrados na leitura."
            }
          },
          required: [
            "establishment",
            "cnpj",
            "date",
            "time",
            "total",
            "paymentMethod",
            "category",
            "subcategory",
            "items",
            "confidence",
            "description",
            "warnings"
          ]
        }
      }
    });

    if (!response?.text) {
      throw new Error("O Gemini não retornou conteúdo.");
    }

    const cleanedResult = response.text
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "");

    const parsedData = JSON.parse(cleanedResult);

    const allowedCategories = [
      "Alimentação",
      "Transporte",
      "Saúde",
      "Educação",
      "Lazer",
      "Utilities",
      "Outros"
    ];

    const cnpjDigits = String(parsedData.cnpj || "").replace(/\D/g, "");
    const totalNumber = Number(parsedData.total);
    const confidenceNumber = Number(parsedData.confidence);

    const validatedData = {
      establishment:
        typeof parsedData.establishment === "string"
          ? parsedData.establishment.trim()
          : "",

      cnpj:
        cnpjDigits.length === 14
          ? cnpjDigits
          : "",

      date:
        typeof parsedData.date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(parsedData.date)
          ? parsedData.date
          : "",

      time:
        typeof parsedData.time === "string" &&
        /^\d{2}:\d{2}$/.test(parsedData.time)
          ? parsedData.time
          : "",

      total:
        Number.isFinite(totalNumber) && totalNumber > 0
          ? Number(totalNumber.toFixed(2))
          : 0,

      paymentMethod:
        typeof parsedData.paymentMethod === "string"
          ? parsedData.paymentMethod.trim()
          : "",

      category:
        allowedCategories.includes(parsedData.category)
          ? parsedData.category
          : "Outros",

      subcategory:
        typeof parsedData.subcategory === "string"
          ? parsedData.subcategory.trim()
          : "",

      items:
        Array.isArray(parsedData.items)
          ? parsedData.items
              .filter((item: unknown) => typeof item === "string")
              .map((item: string) => item.trim())
              .filter(Boolean)
          : [],

      confidence:
        Number.isFinite(confidenceNumber)
          ? Math.max(0, Math.min(100, Math.round(confidenceNumber)))
          : 0,

      description:
        typeof parsedData.description === "string"
          ? parsedData.description.trim()
          : "",

      warnings:
        Array.isArray(parsedData.warnings)
          ? parsedData.warnings
              .filter((warning: unknown) => typeof warning === "string")
              .map((warning: string) => warning.trim())
              .filter(Boolean)
          : []
    };

    console.log(
      "Resultado validado do OCR:",
      JSON.stringify(validatedData, null, 2)
    );

    return res.json(validatedData);
  } catch (err: any) {
    console.error("Gemini AI OCR Scan failed:", {
      message: err?.message,
      status: err?.status,
      code: err?.code,
      stack: err?.stack
    });

    const status =
      typeof err?.status === "number" &&
      err.status >= 400 &&
      err.status <= 599
        ? err.status
        : 502;

    return res.status(status).json({
      success: false,
      error: "Falha ao processar a imagem com o Gemini.",
      details: err?.message || String(err),
      status,
      code: err?.code || "GEMINI_OCR_ERROR"
    });
  }
});
export default app;