/**
 * server.js — Gateway NFS-e (Portal Nacional) com mTLS (certificado A1)
 *
 * Requisitos:
 * - Certificado A1 em .pfx (PKCS#12)
 * - Senha do .pfx
 *
 * Variáveis de ambiente (Render):
 * - PORT=3000 (Render define)
 * - NACIONAL_BASE_URL=https://... (base do Portal Nacional)
 * - CERT_PFX_BASE64=... (conteúdo do .pfx em base64)
 * - CERT_PFX_PASSPHRASE=... (senha do .pfx)
 *
 * Observação:
 * - A doc indica TLS 1.2+ com autenticação mútua (mTLS). :contentReference[oaicite:4]{index=4}
 * - Mensagens em JSON e documentos em XML (muitas vezes GZip+Base64). :contentReference[oaicite:5]{index=5}
 */

const express = require("express");
const https = require("https");
const axios = require("axios");
const zlib = require("zlib");

const app = express();

// ===== Config =====

// Troque para a base real do Portal Nacional (conforme seu ambiente).
// Ex.: https://api-nfse.xxx.gov.br/contribuintes (exemplo fictício)
const NACIONAL_BASE_URL = process.env.NACIONAL_BASE_URL;

const CERT_PFX_BASE64 = process.env.CERT_PFX_BASE64; // seu .pfx convertido para base64
const CERT_PFX_PASSPHRASE = process.env.CERT_PFX_PASSPHRASE;

if (!NACIONAL_BASE_URL) {
  console.warn("⚠️ NACIONAL_BASE_URL não definido. Configure no Render.");
}
if (!CERT_PFX_BASE64 || !CERT_PFX_PASSPHRASE) {
  console.warn("⚠️ CERT_PFX_BASE64 / CERT_PFX_PASSPHRASE não definidos. Configure no Render.");
}

// Cria o agente HTTPS com certificado de cliente (mTLS)
function buildMtlsAgent() {
  const pfx = Buffer.from(CERT_PFX_BASE64, "base64");

  return new https.Agent({
    pfx,
    passphrase: CERT_PFX_PASSPHRASE,

    // Recomendado em produção manter validação de CA ligada.
    // Se você estiver em homologação e tiver problema com cadeia, resolva a CA;
    // não desligue isso sem necessidade.
    rejectUnauthorized: true,

    minVersion: "TLSv1.2",
  });
}

function buildAxios() {
  const httpsAgent = buildMtlsAgent();
  return axios.create({
    baseURL: NACIONAL_BASE_URL,
    httpsAgent,
    timeout: 60000,
    // A API é REST e trabalha com JSON (doc). :contentReference[oaicite:6]{index=6}
    headers: {
      Accept: "application/json",
    },
  });
}

// ===== Helpers =====

// Muitos portais devolvem XML compactado (GZip) e base64 no campo ArquivoXml. :contentReference[oaicite:7]{index=7}
function tryDecodeXml(arquivoXml) {
  if (!arquivoXml) return null;

  // Tenta 1) Base64+GZip → XML string
  try {
    const buff = Buffer.from(arquivoXml, "base64");
    const unzipped = zlib.gunzipSync(buff);
    const xml = unzipped.toString("utf8");
    if (xml.trim().startsWith("<")) return xml;
  } catch (_) {
    // ignore
  }

  // Tenta 2) Base64 direto (sem gzip)
  try {
    const buff = Buffer.from(arquivoXml, "base64");
    const s = buff.toString("utf8");
    if (s.trim().startsWith("<")) return s;
  } catch (_) {
    // ignore
  }

  // Tenta 3) Já é XML “cru”
  if (typeof arquivoXml === "string" && arquivoXml.trim().startsWith("<")) {
    return arquivoXml;
  }

  return null;
}

function safeInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ===== Rotas =====

// 1) Distribuição — você chama do Make
// Internamente chama o endpoint real do Portal Nacional: GET /DFe/{NSU} :contentReference[oaicite:8]{index=8}
app.get("/nfse/distribuicao", async (req, res) => {
  const nsu = safeInt(req.query.nsu, 0);
  const cnpjConsulta = req.query.cnpjConsulta; // opcional conforme doc :contentReference[oaicite:9]{index=9}
  const lote = req.query.lote ?? "true"; // opcional conforme doc :contentReference[oaicite:10]{index=10}

  try {
    const api = buildAxios();

    const response = await api.get(`/DFe/${nsu}`, {
      params: {
        cnpjConsulta,
        lote,
      },
    });

    // Retorna exatamente o JSON que veio do portal (facilita debugar no Make)
    return res.status(200).json(response.data);
  } catch (err) {
    const status = err?.response?.status || 500;
    const data = err?.response?.data || { message: err.message };
    return res.status(status).json({
      erro: "Falha ao consultar Portal Nacional",
      detalhe: data,
    });
  }
});

// 2) Documento XML “downloadável” — para o Make salvar no Google Drive
// Estratégia:
// - Busca a distribuição do NSU (GET /DFe/{NSU}) :contentReference[oaicite:11]{index=11}
// - Pega o primeiro item do LoteDFe e tenta extrair o XML (ArquivoXml)
// - Responde como application/xml e Content-Disposition attachment
app.get("/nfse/documento", async (req, res) => {
  const nsu = safeInt(req.query.nsu, 0);
  const cnpjConsulta = req.query.cnpjConsulta;
  const lote = req.query.lote ?? "true";

  try {
    const api = buildAxios();

    const response = await api.get(`/DFe/${nsu}`, {
      params: { cnpjConsulta, lote },
    });

    const payload = response.data;

    const primeiro = Array.isArray(payload?.LoteDFe) ? payload.LoteDFe[0] : null;
    const xml = tryDecodeXml(primeiro?.ArquivoXml);

    if (!xml) {
      return res.status(404).json({
        erro: "XML não encontrado nesse NSU",
        dica: "Verifique se LoteDFe veio vazio ou se ArquivoXml veio em formato inesperado.",
        retorno: payload,
      });
    }

    // “Força” como arquivo para o Make/Drive
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="nfse_${nsu}.xml"`);
    return res.status(200).send(xml);
  } catch (err) {
    const status = err?.response?.status || 500;
    const data = err?.response?.data || { message: err.message };
    return res.status(status).json({
      erro: "Falha ao obter XML no Portal Nacional",
      detalhe: data,
    });
  }
});

// Healthcheck
app.get("/", (req, res) => res.status(200).send("OK - gateway nfse"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Rodando na porta", PORT));
