/**
 * server.js — Gateway NFS-e (Portal Nacional) com mTLS (certificado A1)
 *
 * Variáveis de ambiente (Render):
 * - PORT (Render define)
 * - NACIONAL_BASE_URL=https://... (BASE da API do Portal Nacional, com basePath se existir)
 * - CERT_PFX_BASE64=... (conteúdo do .pfx em base64)
 * - CERT_PFX_PASSPHRASE=... (senha do .pfx)
 */

const express = require("express");
const https = require("https");
const axios = require("axios");
const zlib = require("zlib");

const app = express();

// ===== Config =====
const NACIONAL_BASE_URL = process.env.NACIONAL_BASE_URL;
const CERT_PFX_BASE64 = process.env.CERT_PFX_BASE64;
const CERT_PFX_PASSPHRASE = process.env.CERT_PFX_PASSPHRASE;

if (!NACIONAL_BASE_URL) {
  console.warn("⚠️ NACIONAL_BASE_URL não definido. Configure no Render.");
}
if (!CERT_PFX_BASE64 || !CERT_PFX_PASSPHRASE) {
  console.warn("⚠️ CERT_PFX_BASE64 / CERT_PFX_PASSPHRASE não definidos. Configure no Render.");
}

// ===== mTLS =====
function buildMtlsAgent() {
  if (!CERT_PFX_BASE64) throw new Error("CERT_PFX_BASE64 ausente");
  if (!CERT_PFX_PASSPHRASE) throw new Error("CERT_PFX_PASSPHRASE ausente");

  const pfx = Buffer.from(CERT_PFX_BASE64, "base64");

  return new https.Agent({
    pfx,
    passphrase: CERT_PFX_PASSPHRASE,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
  });
}

function buildAxios() {
  if (!NACIONAL_BASE_URL) throw new Error("NACIONAL_BASE_URL ausente");

  const httpsAgent = buildMtlsAgent();

  return axios.create({
    baseURL: NACIONAL_BASE_URL,
    httpsAgent,
    timeout: 60000,
    headers: {
      // Mais permissivo: ajuda quando a API responde text/plain ou XML em alguns casos
      Accept: "application/json, text/plain, application/xml, */*",
    },
  });
}

// ===== Helpers =====
function safeInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeBool(v, fallback = true) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase().trim();
  if (s === "true" || s === "1" || s === "sim") return true;
  if (s === "false" || s === "0" || s === "nao" || s === "não") return false;
  return fallback;
}

// Muitos portais devolvem XML compactado (GZip) e base64 no campo ArquivoXml.
function tryDecodeXml(arquivoXml) {
  if (!arquivoXml) return null;

  // 1) Base64 + GZip
  try {
    const buff = Buffer.from(arquivoXml, "base64");
    const unzipped = zlib.gunzipSync(buff);
    const xml = unzipped.toString("utf8");
    if (xml.trim().startsWith("<")) return xml;
  } catch (_) {
    // ignore
  }

  // 2) Base64 direto
  try {
    const buff = Buffer.from(arquivoXml, "base64");
    const s = buff.toString("utf8");
    if (s.trim().startsWith("<")) return s;
  } catch (_) {
    // ignore
  }

  // 3) já é XML cru
  if (typeof arquivoXml === "string" && arquivoXml.trim().startsWith("<")) {
    return arquivoXml;
  }

  return null;
}

function buildErrorDebug(err, defaultMessage) {
  const status = err?.response?.status || 500;
  const respData = err?.response?.data || { message: err?.message || defaultMessage };
  const baseURL = err?.config?.baseURL;
  const url = err?.config?.url;
  const fullUrl = `${baseURL || ""}${url || ""}`;

  return { status, respData, baseURL, url, fullUrl };
}

// ===== Rotas =====

// Healthcheck
app.get("/", (req, res) => res.status(200).send("OK - gateway nfse"));

// 1) Distribuição — chama GET /DFe/{NSU}
app.get("/nfse/distribuicao", async (req, res) => {
  // Exigir NSU para evitar /DFe/0 sem querer
  if (!req.query.nsu) {
    return res.status(400).json({ erro: "Informe o parâmetro nsu (ex: ?nsu=1)" });
  }

  const nsu = safeInt(req.query.nsu, 0);
  const cnpjConsulta = req.query.cnpjConsulta;
  const lote = safeBool(req.query.lote, true);

  try {
    const api = buildAxios();

    const response = await api.get(`/DFe/${nsu}`, {
      params: { cnpjConsulta, lote },
    });

    return res.status(200).json(response.data);
  } catch (err) {
    const dbg = buildErrorDebug(err, "Falha ao consultar Portal Nacional");
    return res.status(dbg.status).json({
      erro: "Falha ao consultar Portal Nacional",
      status: dbg.status,
      fullUrl: dbg.fullUrl,
      detalhe: dbg.respData,
    });
  }
});

// 2) Documento XML — busca /DFe/{NSU} e extrai ArquivoXml
app.get("/nfse/documento", async (req, res) => {
  if (!req.query.nsu) {
    return res.status(400).json({ erro: "Informe o parâmetro nsu (ex: ?nsu=1)" });
  }

  const nsu = safeInt(req.query.nsu, 0);
  const cnpjConsulta = req.query.cnpjConsulta;
  const lote = safeBool(req.query.lote, true);

  try {
    const api = buildAxios();

    const response = await api.get(`/DFe/${nsu}`, {
      params: { cnpjConsulta, lote },
    });

    const payload = response.data;

    // Procura o primeiro item que realmente tenha ArquivoXml
    const itemComXml = Array.isArray(payload?.LoteDFe)
      ? payload.LoteDFe.find((x) => x?.ArquivoXml)
      : null;

    const xml = tryDecodeXml(itemComXml?.ArquivoXml);

    if (!xml) {
      return res.status(404).json({
        erro: "XML não encontrado nesse NSU",
        dica: "Verifique se LoteDFe veio vazio, se o NSU existe, ou se ArquivoXml veio em formato inesperado.",
        retorno: payload,
      });
    }

    // Força como arquivo para Make/Drive
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="nfse_${nsu}.xml"`);
    return res.status(200).send(xml);
  } catch (err) {
    const dbg = buildErrorDebug(err, "Falha ao obter XML no Portal Nacional");
    return res.status(dbg.status).json({
      erro: "Falha ao obter XML no Portal Nacional",
      status: dbg.status,
      fullUrl: dbg.fullUrl,
      detalhe: dbg.respData,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Rodando na porta", PORT));
