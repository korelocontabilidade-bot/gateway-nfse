const express = require("express");
const app = express();

// 1) Distribuição (retorna status e lista)
app.get("/nfse/distribuicao", (req, res) => {
  const nsu = Number(req.query.nsu || 0);

  res.json({
    StatusProcessamento: "NENHUM_DOCUMENTO_LOCALIZADO",
    ultimoNSU: nsu,
    LoteDFe: []
  });
});

// 2) Documento (retorna XML)
app.get("/nfse/documento", (req, res) => {
  const nsu = req.query.nsu || "0";

  const xml = `
<Nfse>
  <InfNfse>
    <Numero>${nsu}</Numero>
    <Valor>100.00</Valor>
    <Prestador>Empresa Teste</Prestador>
  </InfNfse>
</Nfse>
  `.trim();

  res.set("Content-Type", "application/xml");
  res.send(xml);
});

// porta (se você já tem, mantém a sua)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Rodando na porta", PORT));
